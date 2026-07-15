const API_VERSION = 2;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ERROR_DETAILS_DEPTH = 8;
const MAX_ERROR_DETAILS_NODES = 2048;
const MAX_ERROR_DETAILS_STRING_LENGTH = 16384;
const MAX_ERROR_DETAILS_TOTAL_STRING_LENGTH = 65536;
const UNSAFE_ERROR_DETAIL_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const FETCH_CONTENT_TYPE = "text/plain;charset=UTF-8";
const GAS_ENDPOINT_ORIGIN = "https://script.google.com";
const GAS_RESPONSE_ORIGIN = "https://script.googleusercontent.com";
const GAS_ENDPOINT_PATH_PATTERN = /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export class Version2ApiProtocolError extends Error {
  constructor(message, reason = "PROTOCOL_MISMATCH") {
    super(message);
    this.name = "Version2ApiProtocolError";
    this.reason = reason;
  }
}

export class Version2ApiTransportError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "Version2ApiTransportError";
    this.reason = reason;
  }
}

export function createVersion2FetchTransport({
  endpoint
} = {}) {
  const endpointConfig = validateFetchEndpoint(endpoint);
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  return async function version2FetchTransport(request) {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(),
      DEFAULT_FETCH_TIMEOUT_MS
    );
    try {
      const response = await globalThis.fetch(endpointConfig.url.href, {
        method: "POST",
        mode: "cors",
        redirect: "follow",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: Object.freeze({
          Accept: "application/json",
          "Content-Type": FETCH_CONTENT_TYPE
        }),
        body: JSON.stringify(request),
        signal: controller.signal
      });
      createSafeResponseMeta(response, endpointConfig.expectedResponseOrigin);

      const body = await response.text();
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Version2ApiProtocolError(
          "The Version2 API response was not valid JSON.",
          "MALFORMED_JSON"
        );
      }
    } catch (error) {
      if (
        error instanceof Version2ApiProtocolError
        || error instanceof Version2ApiTransportError
      ) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw transportError_("TIMEOUT", "The Version2 API request timed out.");
      }
      throw transportError_(
        "TRANSPORT_FAILURE",
        "The Version2 API request could not be completed."
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  };
}

export function createVersion2ApiClient({ transport }) {
  if (typeof transport !== "function") {
    throw new TypeError("A transport function is required.");
  }

  return Object.freeze({
    async request(action, payload = {}) {
      if (typeof action !== "string" || action.length === 0 || !isPlainObject(payload)) {
        throw new TypeError("A valid action and payload are required.");
      }

      const rawResponse = await transport(Object.freeze({
        apiVersion: API_VERSION,
        action,
        payload: Object.freeze({ ...payload })
      }));
      return parseVersion2ApiResponse(rawResponse);
    }
  });
}

export function parseVersion2ApiResponse(value) {
  if (!isPlainObject(value)) throw protocolError();
  if (typeof value.ok !== "boolean") throw protocolError();
  if (!isUuidV4(value.requestId) || !isUtcTimestamp(value.serverTime)) throw protocolError();

  let safeErrorDetails = null;
  if (value.ok) {
    if (!isPlainObject(value.data) || value.error !== null) throw protocolError();
  } else if (
    value.data !== null
    || !isPlainObject(value.error)
    || typeof value.error.code !== "string"
    || value.error.code.length === 0
    || typeof value.error.message !== "string"
    || value.error.message.length === 0
    || !Object.prototype.hasOwnProperty.call(value.error, "details")
  ) {
    throw protocolError();
  } else {
    safeErrorDetails = cloneSafeErrorDetails(value.error.details);
  }

  return Object.freeze({
    ok: value.ok,
    data: value.ok ? Object.freeze({ ...value.data }) : null,
    error: value.ok ? null : Object.freeze({
      code: value.error.code,
      message: value.error.message,
      details: safeErrorDetails
    }),
    requestId: value.requestId,
    serverTime: value.serverTime
  });
}

function cloneSafeErrorDetails(value) {
  const state = {
    seen: new WeakSet(),
    nodes: 0,
    stringLength: 0
  };
  return cloneSafeJsonValue(value, 0, state);
}

function cloneSafeJsonValue(value, depth, state) {
  if (depth > MAX_ERROR_DETAILS_DEPTH) throw protocolError();
  state.nodes += 1;
  if (state.nodes > MAX_ERROR_DETAILS_NODES) throw protocolError();

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_ERROR_DETAILS_STRING_LENGTH) throw protocolError();
    state.stringLength += value.length;
    if (state.stringLength > MAX_ERROR_DETAILS_TOTAL_STRING_LENGTH) throw protocolError();
    return value;
  }
  if (typeof value !== "object") throw protocolError();
  if (state.seen.has(value)) throw protocolError();
  state.seen.add(value);

  if (Array.isArray(value)) {
    const clone = [];
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (key === "length") continue;
      if (
        typeof key !== "string"
        || UNSAFE_ERROR_DETAIL_KEYS.has(key)
        || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= value.length
      ) {
        throw protocolError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
        throw protocolError();
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw protocolError();
      clone.push(cloneSafeJsonValue(value[index], depth + 1, state));
    }
    state.seen.delete(value);
    return Object.freeze(clone);
  }
  if (!isPlainObject(value)) throw protocolError();

  const clone = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || UNSAFE_ERROR_DETAIL_KEYS.has(key)) throw protocolError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) throw protocolError();
    state.stringLength += key.length;
    if (state.stringLength > MAX_ERROR_DETAILS_TOTAL_STRING_LENGTH) throw protocolError();
    clone[key] = cloneSafeJsonValue(descriptor.value, depth + 1, state);
  }
  state.seen.delete(value);
  return Object.freeze(clone);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateFetchEndpoint(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("A Version2 API endpoint is required.");
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new TypeError("A valid Version2 API endpoint is required.");
  }

  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("The Version2 API endpoint must not contain credentials or query data.");
  }

  if (
    endpoint.origin !== GAS_ENDPOINT_ORIGIN
    || !GAS_ENDPOINT_PATH_PATTERN.test(endpoint.pathname)
  ) {
    throw new TypeError("The Version2 API endpoint must be an approved GAS Web App URL.");
  }
  return Object.freeze({ url: endpoint, expectedResponseOrigin: GAS_RESPONSE_ORIGIN });
}

function createSafeResponseMeta(response, expectedResponseOrigin) {
  if (!response || typeof response.text !== "function") {
    throw transportError_("TRANSPORT_FAILURE", "The Version2 API returned an invalid response.");
  }

  let finalOrigin = null;
  if (typeof response.url === "string" && response.url.length > 0) {
    try {
      finalOrigin = new URL(response.url).origin;
    } catch (error) {
      throw transportError_(
        "TRANSPORT_FAILURE",
        "The Version2 API returned an invalid response URL."
      );
    }
  }
  if (finalOrigin !== expectedResponseOrigin) {
    throw transportError_(
      "UNTRUSTED_REDIRECT",
      "The Version2 API redirected to an untrusted origin."
    );
  }

  return Object.freeze({
    status: Number.isInteger(response.status) ? response.status : null,
    ok: response.ok === true,
    redirected: response.redirected === true,
    finalOrigin,
    contentType: response.headers && typeof response.headers.get === "function"
      ? response.headers.get("content-type")
      : null
  });
}

function transportError_(reason, message) {
  return new Version2ApiTransportError(reason, message);
}

function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isUtcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function protocolError() {
  return new Version2ApiProtocolError("The API response does not match the Version2 contract.");
}
