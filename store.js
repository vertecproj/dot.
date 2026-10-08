/* Ponto — armazenamento
   Supabase Auth + tabela vaults (1 linha por usuário, dados cifrados com AES-256-GCM no navegador).
   Economia de requisições: 1 leitura ao entrar, escrita agrupada (debounce 2,5 s) + ao sair da tela. */
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = u8 => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rnd = n => crypto.getRandomValues(new Uint8Array(n));

  async function deriveKey(secret, saltB64) {
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: ub64(saltB64), iterations: 310000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  }
  async function seal(key, bytes) { const iv = rnd(12); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes); return b64(iv) + "." + b64(ct); }
  async function open(key, s) { const [iv, ct] = s.split("."); return crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(iv) }, key, ub64(ct)); }
  async function wrap(dataKey, secret, salt) { const raw = await crypto.subtle.exportKey("raw", dataKey); return seal(await deriveKey(secret, salt), raw); }
  async function unwrap(s, secret, salt) {
    const raw = await open(await deriveKey(secret, salt), s);
    return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  const cfg = window.CV_CONFIG || {};
  const cloudReady = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const sb = cloudReady ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true } }) : null;

  let mode = null, dataKey = null, version = 0, user = null, timer = null, pending = null, onStatus = () => {};
  const KEYCACHE = "ponto.k"; // chave dos dados: sessionStorage (só esta aba) ou localStorage ("lembrar" ligado)
  const REMEMBER = "ponto.remember"; // "1" = manter a chave entre reaberturas do app, sem digitar senha de novo
  const BIO_PREFIX = "ponto.bio."; // por e-mail: credencial WebAuthn + chave de dados embrulhada por ela

  const remembered = () => { try { return localStorage.getItem(REMEMBER) === "1"; } catch (e) { return false; } };
  async function cacheKey() {
    try {
      const raw = b64(await crypto.subtle.exportKey("raw", dataKey));
      (remembered() ? localStorage : sessionStorage).setItem(KEYCACHE, raw);
      (remembered() ? sessionStorage : localStorage).removeItem(KEYCACHE); // não deixa cópia velha no outro lugar
    } catch (e) {}
  }
  async function restoreKey() {
    try { const s = localStorage.getItem(KEYCACHE) || sessionStorage.getItem(KEYCACHE); if (s) dataKey = await crypto.subtle.importKey("raw", ub64(s), "AES-GCM", true, ["encrypt", "decrypt"]); } catch (e) {}
    return !!dataKey;
  }

  /* ---------- biometria (WebAuthn + extensão PRF): a impressão/rosto nunca sai do aparelho.
     O navegador devolve um segredo estável ligado à credencial; usamos esse segredo para embrulhar
     a MESMA chave de dados (AES-256) que a senha já protege — a biometria não troca a senha, é um atalho local. */
  const canWebAuthn = () => !!(window.PublicKeyCredential && navigator.credentials);
  async function bioSupported() { try { return canWebAuthn() && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { return false; } }
  function bioRecord(email) { try { return JSON.parse(localStorage.getItem(BIO_PREFIX + email.toLowerCase()) || "null"); } catch (e) { return null; } }
  const prfKey = async prfBytes => crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", prfBytes), "AES-GCM", false, ["encrypt", "decrypt"]);

  async function bioEnroll(email) {
    if (!dataKey) throw new Error("sem sessão ativa");
    const salt = rnd(32);
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rnd(32), rp: { name: "dot." },
      user: { id: enc.encode(email), name: email, displayName: email },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      extensions: { prf: { eval: { first: salt } } }, timeout: 60000,
    } });
    const prf = cred.getClientExtensionResults().prf?.results?.first;
    if (!prf) throw new Error("PRF_UNSUPPORTED"); // navegador aceitou a credencial mas não sabe derivar segredo (raro, mas existe)
    const wrapped = await seal(await prfKey(prf), await crypto.subtle.exportKey("raw", dataKey));
    localStorage.setItem(BIO_PREFIX + email.toLowerCase(), JSON.stringify({ credId: b64(new Uint8Array(cred.rawId)), salt: b64(salt), wrapped }));
  }
  async function bioUnlock(email) {
    const rec = bioRecord(email); if (!rec) throw new Error("NO_BIO");
    const salt = ub64(rec.salt);
    const assertion = await navigator.credentials.get({ publicKey: {
      challenge: rnd(32), allowCredentials: [{ id: ub64(rec.credId), type: "public-key", transports: ["internal"] }],
      userVerification: "required", extensions: { prf: { eval: { first: salt } } }, timeout: 60000,
    } });
    const prf = assertion.getClientExtensionResults().prf?.results?.first;
    if (!prf) throw new Error("PRF_UNSUPPORTED");
    const raw = await open(await prfKey(prf), rec.wrapped);
    dataKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  async function pull() {
    const { data, error } = await sb.from("ponto_vaults").select("*").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  /* sem código para guardar: a "chave de recuperação" é derivada do id da conta (o servidor consegue reabrir o cofre; acesso só após o código do e-mail) */
  const autoRec = () => "dot-rec-v1:" + user.id;
  async function ensureAutoRec(row) { // cofres antigos (com código aleatório guardado pelo usuário) passam para a chave automática no próximo login com senha
    try { await unwrap(row.key_rec, autoRec(), row.rec_salt); return; } catch (e) {}
    const rec_salt = b64(rnd(16));
    await sb.from("ponto_vaults").update({ rec_salt, key_rec: await wrap(dataKey, autoRec(), rec_salt) }).eq("user_id", user.id);
  }

  const Store = {
    cloudReady,
    get mode() { return mode; },
    get user() { return user; },
    onStatus(fn) { onStatus = fn; },

    /* sessão já aberta (ex.: recarregou a página) */
    async resume() {
      if (!sb) return null;
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      user = data.session.user;
      if (!(await restoreKey())) {
        const bioAvail = !!bioRecord(user.email) && await bioSupported();
        return { needPassword: true, email: user.email, bioAvail };
      }
      const row = await pull(); if (!row) return { needPassword: true, email: user.email };
      mode = "cloud"; version = row.version;
      return { state: JSON.parse(dec.decode(await open(dataKey, row.data))) };
    },

    async signUp(email, password, initialState) {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) return { confirmEmail: true };
      user = data.session.user;
      return this.createVault(password, initialState);
    },

    async createVault(password, initialState) {
      dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      const rec = autoRec(), kdf_salt = b64(rnd(16)), rec_salt = b64(rnd(16));
      const row = { user_id: user.id, version: 1, kdf_salt, rec_salt,
        key_pw: await wrap(dataKey, password, kdf_salt), key_rec: await wrap(dataKey, rec, rec_salt),
        data: await seal(dataKey, enc.encode(JSON.stringify(initialState))) };
      const { error } = await sb.from("ponto_vaults").insert(row);
      if (error) throw error;
      mode = "cloud"; version = 1; await cacheKey();
      return { state: initialState };
    },

    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      user = data.user;
      const row = await pull();
      if (!row) return { noVault: true };
      try { dataKey = await unwrap(row.key_pw, password, row.kdf_salt); await ensureAutoRec(row).catch(() => {}); }
      catch (e) { // senha trocada por e-mail sem terminar: a chave automática reabre o cofre e a senha digitada vira a nova
        dataKey = await unwrap(row.key_rec, autoRec(), row.rec_salt);
        const kdf_salt = b64(rnd(16));
        await sb.from("ponto_vaults").update({ kdf_salt, key_pw: await wrap(dataKey, password, kdf_salt) }).eq("user_id", user.id);
      }
      mode = "cloud"; version = row.version; await cacheKey();
      return { state: JSON.parse(dec.decode(await open(dataKey, row.data))) };
    },

    /* esqueceu a senha: o código do e-mail prova quem é; a chave automática do cofre (derivada da conta) reabre os dados */
    inRecovery: false,
    async recover(newPassword) {
      if (this.inRecovery) { const { error } = await sb.auth.updateUser({ password: newPassword }); if (error) throw error; this.inRecovery = false; }
      const { data: s } = await sb.auth.getUser(); user = s.user;
      const row = await pull();
      dataKey = await unwrap(row.key_rec, autoRec(), row.rec_salt);
      const kdf_salt = b64(rnd(16));
      const { error } = await sb.from("ponto_vaults").update({ kdf_salt, key_pw: await wrap(dataKey, newPassword, kdf_salt) }).eq("user_id", user.id);
      if (error) throw error;
      mode = "cloud"; version = row.version; await cacheKey();
      return { state: JSON.parse(dec.decode(await open(dataKey, row.data))) };
    },

    async resetEmail(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error && !/rate|seconds/i.test(error.message)) throw error;
    },
    /* códigos de 6 dígitos por e-mail (templates do Supabase usam {{ .Token }}) */
    async verifyCode(email, token, type) {
      const { data, error } = await sb.auth.verifyOtp({ email, token: token.replace(/\D/g, ""), type });
      if (error) throw error;
      user = data.user || data.session?.user;
      if (type === "recovery") this.inRecovery = true;
      return data;
    },
    async resendSignup(email) {
      const { error } = await sb.auth.resend({ type: "signup", email });
      if (error && !/rate|seconds/i.test(error.message)) throw error;
    },
    /* mensageiro = Google Apps Script do admin (pedidos de conta e código de senha, enviados pelo Gmail dele) */
    async messenger(payload) {
      if (!cfg.MESSENGER_URL) throw new Error("mensageiro não configurado");
      const r = await fetch(cfg.MESSENGER_URL, { method: "POST", body: JSON.stringify(payload) }); // text/plain: sem preflight CORS
      return r.json();
    },
    async finishReset(email, code, newPassword) {
      const { data, error } = await sb.rpc("finish_reset", { p_email: email, p_code: code, p_new_password: newPassword });
      if (error) throw error;
      return data;
    },

    /* lembrar senha: mantém a chave de dados no aparelho entre reaberturas (sem digitar senha de novo) */
    get remembered() { return remembered(); },
    setRemember(on) {
      try {
        if (on) { localStorage.setItem(REMEMBER, "1"); if (dataKey) cacheKey(); }
        else { localStorage.removeItem(REMEMBER); localStorage.removeItem(KEYCACHE); if (dataKey) cacheKey(); }
      } catch (e) {}
    },
    /* biometria (Face ID / digital): some se o navegador/aparelho não suportar */
    bioSupported,
    bioEnabled(email) { return !!bioRecord(email); },
    async bioEnroll(email) { await bioEnroll(email); },
    async bioUnlock(email) {
      await bioUnlock(email);
      const { data } = await sb.auth.getSession(); user = data.session.user;
      const row = await pull(); if (!row) throw new Error("sem cofre");
      mode = "cloud"; version = row.version;
      return { state: JSON.parse(dec.decode(await open(dataKey, row.data))) };
    },
    bioForget(email) { try { localStorage.removeItem(BIO_PREFIX + email.toLowerCase()); } catch (e) {} },

    async changePassword(newPassword) {
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw error;
      const kdf_salt = b64(rnd(16));
      await sb.from("ponto_vaults").update({ kdf_salt, key_pw: await wrap(dataKey, newPassword, kdf_salt) }).eq("user_id", user.id);
    },

    /* agenda gravação (agrupa várias mudanças numa requisição só) */
    save(state) {
      if (mode !== "cloud") return;
      pending = state; onStatus("busy");
      clearTimeout(timer); timer = setTimeout(() => this.flush(), 2500);
    },
    async flush() {
      if (mode !== "cloud" || !pending) return;
      const state = pending; pending = null; clearTimeout(timer);
      try {
        const data = await seal(dataKey, enc.encode(JSON.stringify(state)));
        const { data: rows, error } = await sb.from("ponto_vaults")
          .update({ data, version: version + 1, updated_at: new Date().toISOString() })
          .eq("user_id", user.id).eq("version", version).select("version");
        if (error) throw error;
        if (!rows.length) { onStatus("conflict"); return; } // outro aparelho salvou antes
        version = rows[0].version; onStatus("ok");
      } catch (e) { pending = pending || state; onStatus("err"); }
    },
    async reload() { const row = await pull(); version = row.version; return JSON.parse(dec.decode(await open(dataKey, row.data))); },

    async signOut() {
      await this.flush();
      try { sessionStorage.removeItem(KEYCACHE); localStorage.removeItem(KEYCACHE); } catch (e) {}
      if (sb && mode === "cloud") await sb.auth.signOut();
      mode = null; dataKey = null; user = null;
    },
    async deleteAccount() {
      const email = user?.email;
      await sb.from("ponto_vaults").delete().eq("user_id", user.id);
      await this.signOut();
      if (email) this.bioForget(email);
    },
  };

  // link "esqueci a senha" do e-mail abre o app numa sessão de recuperação
  if (sb) sb.auth.onAuthStateChange(ev => { if (ev === "PASSWORD_RECOVERY") { Store.inRecovery = true; Store.onRecoveryLink?.(); } });

  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") Store.flush(); });
  window.Store = Store;
})();
