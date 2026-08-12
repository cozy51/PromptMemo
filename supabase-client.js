// A very small Supabase client, written against the REST endpoints directly.
//
// The official supabase-js bundle cannot be loaded from a CDN inside an
// extension — MV3 only runs scripts that ship with the package — and this
// feature needs just two things from it: password sign-in with token refresh,
// and the storage object API.  Both are plain `fetch` calls, so vendoring a
// large dependency would buy nothing.
function createPromptMemoSupabaseClient({ url, anonKey, loadSession, saveSession }) {
  const base = String(url || "").replace(/\/+$/, "");
  let session = null;
  let refreshing = null;

  function encodePath(path) {
    return String(path).split("/").map(encodeURIComponent).join("/");
  }

  function headers(extra = {}) {
    return { apikey: anonKey, ...extra };
  }

  function normalizeSession(payload) {
    if (!payload?.access_token || !payload?.refresh_token) return null;
    const lifetime = Number(payload.expires_in);
    return {
      accessToken: String(payload.access_token),
      refreshToken: String(payload.refresh_token),
      expiresAt: Number.isFinite(payload.expires_at)
        ? payload.expires_at * 1000
        : Date.now() + (Number.isFinite(lifetime) ? lifetime : 3600) * 1000,
      user: {
        id: String(payload.user?.id || session?.user?.id || ""),
        email: String(payload.user?.email || session?.user?.email || "")
      }
    };
  }

  async function store(next) {
    session = next;
    await saveSession?.(next);
    return next;
  }

  async function readAuthError(response) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return String(parsed.error_description || parsed.msg || parsed.message || text);
    } catch (_error) {
      return text;
    }
  }

  async function token(grantType, body) {
    const response = await fetch(`${base}/auth/v1/token?grant_type=${grantType}`, {
      method: "POST",
      cache: "no-store",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await readAuthError(response);
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    const next = normalizeSession(await response.json());
    if (!next) throw new Error("ログイン応答を読み取れませんでした");
    return store(next);
  }

  // Refresh a little before the token actually expires: a request that starts
  // valid and finishes expired would otherwise fail for no useful reason.
  const REFRESH_MARGIN_MS = 60 * 1000;

  async function accessToken() {
    if (!session) return "";
    if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
    // One refresh at a time: two parallel calls would each spend the refresh
    // token, and the loser's copy is then rejected for good.
    if (!refreshing) {
      refreshing = token("refresh_token", { refresh_token: session.refreshToken })
        .finally(() => { refreshing = null; });
    }
    const refreshed = await refreshing;
    return refreshed.accessToken;
  }

  async function authHeaders(extra = {}) {
    const value = await accessToken();
    if (!value) throw new Error("同期のセッションが切れました。ログインし直してください");
    return headers({ Authorization: `Bearer ${value}`, ...extra });
  }

  async function storageRequest(path, options = {}) {
    const response = await fetch(`${base}/storage/v1/${path}`, {
      cache: "no-store",
      ...options,
      headers: await authHeaders(options.headers || {})
    });
    if (response.status === 401) {
      // The stored session is no longer accepted; drop it so the popup asks for
      // a fresh sign-in instead of retrying forever.
      await store(null);
      throw new Error("同期のセッションが切れました。ログインし直してください");
    }
    return response;
  }

  return {
    async init() {
      session = (await loadSession?.()) || null;
      if (!session?.refreshToken) {
        session = null;
        return null;
      }
      try {
        await accessToken();
      } catch (_error) {
        // An expired or revoked refresh token is not an error worth reporting:
        // it simply means this browser has to sign in again.
        await store(null);
      }
      return session;
    },

    getUser() {
      return session?.user?.id ? session.user : null;
    },

    async signIn(email, password) {
      await token("password", { email, password });
      return session.user;
    },

    async signOut() {
      const current = session;
      await store(null);
      if (!current) return;
      try {
        await fetch(`${base}/auth/v1/logout`, {
          method: "POST",
          headers: headers({ Authorization: `Bearer ${current.accessToken}` })
        });
      } catch (_error) {
        // The local session is already gone, which is what signing out means
        // here; revoking it server-side is a courtesy.
      }
    },

    // The storage CDN may serve a cached copy, and a stale read is precisely the
    // failure this feature exists to prevent, so read through a no-store fetch
    // with a cache-busting query.
    async download(bucket, path) {
      const response = await storageRequest(
        `object/authenticated/${encodeURIComponent(bucket)}/${encodePath(path)}?ts=${Date.now()}`
      );
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 404 || /not.?found|NoSuchKey/i.test(text)) return null;
        throw new Error(`クラウドの読み取りに失敗しました (${response.status})`);
      }
      return text;
    },

    async upload(bucket, path, body) {
      const response = await storageRequest(
        `object/${encodeURIComponent(bucket)}/${encodePath(path)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            // Objects must never be cached: the next device has to see this write.
            "Cache-Control": "max-age=0",
            "x-upsert": "true"
          },
          body
        }
      );
      if (!response.ok) {
        throw new Error(`クラウドへの書き込みに失敗しました (${response.status})`);
      }
    },

    async list(bucket, prefix, { limit = 200, sortBy = { column: "name", order: "desc" } } = {}) {
      const response = await storageRequest(`object/list/${encodeURIComponent(bucket)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit, offset: 0, sortBy })
      });
      if (!response.ok) throw new Error("クラウド履歴を読み込めませんでした");
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    },

    async remove(bucket, paths) {
      if (!paths.length) return;
      const response = await storageRequest(`object/${encodeURIComponent(bucket)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: paths })
      });
      if (!response.ok) throw new Error("古い履歴を削除できませんでした");
    }
  };
}
