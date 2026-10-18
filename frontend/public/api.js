// Bridge API client. The token authorizes this page to the loopback bridge.

let token;
let onRejected = () => {};

export const getToken = () => token;

export function setToken(value) {
  token = value;
  storage("set", "rea-token", value);
}

export function onTokenRejected(callback) {
  onRejected = callback;
}

/** Reads the token from the launch URL fragment, then from this tab's session. */
export function readToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    setToken(fromHash);
    history.replaceState(null, "", location.pathname);
    return fromHash;
  }
  token = storage("get", "rea-token");
  return token;
}

function storage(action, key, value) {
  try {
    if (action === "get") return sessionStorage.getItem(key) ?? undefined;
    sessionStorage.setItem(key, value);
  } catch {
    return undefined;
  }
}

export async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-rea-token": token,
      ...init.headers,
    },
  });
  if (response.status === 401) {
    onRejected();
    throw new Error("The access token was rejected.");
  }
  return response;
}

export async function apiJson(path, init) {
  const response = await api(path, init);
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? `Request failed with ${response.status}.`);
  return body;
}

/** Parses the bridge's newline-delimited call events. */
export async function* ndjson(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}
