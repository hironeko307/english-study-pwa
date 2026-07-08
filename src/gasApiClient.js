import { DATASET_ID, GAS_WEB_APP_URL } from "./config.js";
import { storageService } from "./storageService.js";

export class GasApiClient {
  constructor({ endpoint = "" } = {}) {
    this.endpoint = endpoint;
  }

  setEndpoint(endpoint) {
    this.endpoint = endpoint.trim();
  }

  getEndpoint() {
    return this.endpoint || storageService.legacy.getGasEndpoint() || GAS_WEB_APP_URL;
  }

  async login({ userId, pin }) {
    return this.request("login", { userId, pin });
  }

  async version({ datasetId = DATASET_ID } = {}) {
    return this.request("version", { datasetId });
  }

  async vocabulary({ userId, sessionToken, datasetId = DATASET_ID, version }) {
    return this.request("vocabulary", {
      userId,
      sessionToken,
      datasetId,
      version
    });
  }

  async request(action, payload) {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      throw new Error("GAS Web App URL が設定されていません。");
    }

    // TODO: 将来はJSONPを廃止し、標準的なFetch通信へ移行する。
    if (typeof document !== "undefined") {
      return requestJsonp(endpoint, action, payload);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify({ action, payload })
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("GAS API の応答をJSONとして読めませんでした。");
    }

    if (!response.ok || !result.ok) {
      const message = result?.error?.message || `GAS API request failed: ${action}`;
      const error = new Error(message);
      error.code = result?.error?.code;
      throw error;
    }

    return result.data;
  }
}

function requestJsonp(endpoint, action, payload) {
  return new Promise((resolve, reject) => {
    const callbackName = `__vg2500Jsonp_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const script = document.createElement("script");
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`GAS API request timed out: ${action}`));
    }, 15000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = (result) => {
      cleanup();

      if (!result?.ok) {
        const message = result?.error?.message || `GAS API request failed: ${action}`;
        const error = new Error(message);
        error.code = result?.error?.code;
        reject(error);
        return;
      }

      resolve(result.data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error(`GAS API connection failed: ${action}`));
    };

    const url = new URL(endpoint);
    url.searchParams.set("action", action);
    url.searchParams.set("payload", JSON.stringify(payload));
    url.searchParams.set("callback", callbackName);
    script.src = url.toString();
    document.head.append(script);
  });
}
