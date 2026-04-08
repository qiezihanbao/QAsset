const MENU_ID = "quickasset-save-image";
const DEFAULT_ENDPOINT = "http://127.0.0.1:27124/api/import-image";
const DEFAULT_IMPORT_PATH = "/api/import-image";
const DEFAULT_BYTES_IMPORT_PATH = "/api/import-image-bytes";
const HEALTH_PATH = "/health";
const LAST_WORKING_ENDPOINT_KEY = "lastWorkingEndpoint";
const REQUEST_TIMEOUT_MS = 6000;
const UPLOAD_TIMEOUT_MS = 30000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 800;
const DISCOVERY_COMMON_PORTS = [27124, 27125, 27126, 27127, 4173, 4174, 5173];

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "添加到 QuickAsset",
      contexts: ["image"]
    });
  });
}

function setBadge(tabId, text, color) {
  if (!tabId || tabId < 0) return;
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId });
  }, 2500);
}

function parseUrlSafe(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function uniquePush(arr, value) {
  if (!value || arr.includes(value)) return;
  arr.push(value);
}

function resolvePathCandidate(endpoint) {
  const parsed = parseUrlSafe(endpoint);
  const parsedPath = parsed ? parsed.pathname : "";
  if (!parsedPath || parsedPath === "/") return DEFAULT_IMPORT_PATH;
  return parsedPath.startsWith("/") ? parsedPath : `/${parsedPath}`;
}

function collectCandidateEndpoints(primaryEndpoint, lastWorkingEndpoint) {
  const directCandidates = [];
  uniquePush(directCandidates, lastWorkingEndpoint);
  uniquePush(directCandidates, primaryEndpoint);
  uniquePush(directCandidates, DEFAULT_ENDPOINT);

  const pathCandidates = [];
  uniquePush(pathCandidates, resolvePathCandidate(primaryEndpoint));
  uniquePush(pathCandidates, DEFAULT_IMPORT_PATH);

  const hostCandidates = [];
  const portCandidates = [];

  for (const endpoint of directCandidates) {
    const parsed = parseUrlSafe(endpoint);
    if (!parsed || !isLocalHost(parsed.hostname)) continue;
    uniquePush(hostCandidates, parsed.hostname);

    const parsedPort = Number(parsed.port);
    if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      uniquePush(portCandidates, parsedPort);
      for (let port = parsedPort - 2; port <= parsedPort + 2; port += 1) {
        if (port > 0 && port <= 65535) {
          uniquePush(portCandidates, port);
        }
      }
    }
  }

  if (hostCandidates.length === 0) {
    uniquePush(hostCandidates, "127.0.0.1");
    uniquePush(hostCandidates, "localhost");
  }

  for (const port of DISCOVERY_COMMON_PORTS) {
    uniquePush(portCandidates, port);
  }

  const allCandidates = [...directCandidates];
  for (const host of hostCandidates) {
    for (const port of portCandidates) {
      for (const path of pathCandidates) {
        uniquePush(allCandidates, `http://${host}:${port}${path}`);
      }
    }
  }

  return allCandidates;
}

function toImportEndpoint(endpointLike) {
  const parsed = parseUrlSafe(endpointLike);
  if (!parsed) return DEFAULT_ENDPOINT;
  return `${parsed.origin}${DEFAULT_IMPORT_PATH}`;
}

function toBytesEndpoint(endpointLike) {
  const parsed = parseUrlSafe(endpointLike);
  if (!parsed) return "";
  return `${parsed.origin}${DEFAULT_BYTES_IMPORT_PATH}`;
}

function shouldAttemptBinaryFallback(result) {
  if (!result || result.ok) return false;
  if (result.errorType === "network") return true;
  if (result.errorType !== "http") return false;
  return result.status === 404 || result.status === 502;
}

function inferFileNameFromUrl(urlValue) {
  const parsed = parseUrlSafe(urlValue);
  if (!parsed) return "";
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : "";
  if (!last) return "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestImport(endpoint, payload, headers) {
  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      },
      REQUEST_TIMEOUT_MS
    );

    const responseJson = await readJsonSafe(response);
    if (response.ok) {
      return { ok: true, endpoint, data: responseJson };
    }

    const message =
      (responseJson && responseJson.error) ||
      `${response.status} ${response.statusText || "Request failed"}`;
    return {
      ok: false,
      endpoint,
      errorType: "http",
      status: response.status,
      message
    };
  } catch (err) {
    return {
      ok: false,
      endpoint,
      errorType: "network",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

async function downloadImageForUpload(imageUrl) {
  const response = await fetchWithTimeout(
    imageUrl,
    {
      method: "GET",
      credentials: "include"
    },
    IMAGE_DOWNLOAD_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Image fetch failed with status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (!bytes.length) {
    throw new Error("Downloaded image is empty.");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Image too large: ${bytes.length} bytes`);
  }

  const responseType = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim();
  const fileName = inferFileNameFromUrl(response.url || imageUrl);

  return {
    bytes,
    sourceUrl: imageUrl,
    fileName,
    contentType: responseType || ""
  };
}

async function requestImportBytes(uploadEndpoint, payload, authToken) {
  const headers = {
    "Content-Type": "application/octet-stream"
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const params = new URLSearchParams();
  if (payload.sourceUrl) params.set("sourceUrl", payload.sourceUrl);
  if (payload.pageUrl) params.set("pageUrl", payload.pageUrl);
  if (payload.pageTitle) params.set("pageTitle", payload.pageTitle);
  if (payload.fileName) params.set("fileName", payload.fileName);
  if (payload.contentType) params.set("contentType", payload.contentType);

  const requestUrl = params.toString() ? `${uploadEndpoint}?${params}` : uploadEndpoint;

  try {
    const response = await fetchWithTimeout(
      requestUrl,
      {
        method: "POST",
        headers,
        body: payload.bytes
      },
      UPLOAD_TIMEOUT_MS
    );

    const responseJson = await readJsonSafe(response);
    if (response.ok) {
      return { ok: true, endpoint: uploadEndpoint, data: responseJson };
    }

    const message =
      (responseJson && responseJson.error) ||
      `${response.status} ${response.statusText || "Request failed"}`;
    return {
      ok: false,
      endpoint: uploadEndpoint,
      errorType: "http",
      status: response.status,
      message
    };
  } catch (err) {
    return {
      ok: false,
      endpoint: uploadEndpoint,
      errorType: "network",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

async function probeHealthEndpoint(origin) {
  const healthUrl = `${origin}${HEALTH_PATH}`;
  try {
    const response = await fetchWithTimeout(healthUrl, { method: "GET" }, DISCOVERY_TIMEOUT_MS);
    if (!response.ok) return null;

    const payload = await readJsonSafe(response);
    if (!payload || payload.ok !== true || payload.service !== "quickasset-web-import") {
      return null;
    }

    const endpoint =
      typeof payload.endpoint === "string" && payload.endpoint.trim()
        ? payload.endpoint.trim()
        : `${origin}${DEFAULT_IMPORT_PATH}`;
    const uploadEndpoint =
      (typeof payload.uploadEndpoint === "string" && payload.uploadEndpoint.trim()) ||
      (typeof payload.upload_endpoint === "string" && payload.upload_endpoint.trim()) ||
      `${origin}${DEFAULT_BYTES_IMPORT_PATH}`;

    return {
      endpoint,
      uploadEndpoint
    };
  } catch {
    return null;
  }
}

async function discoverEndpoint(primaryEndpoint, lastWorkingEndpoint) {
  const candidates = collectCandidateEndpoints(primaryEndpoint, lastWorkingEndpoint);
  const origins = [];
  for (const endpoint of candidates) {
    const parsed = parseUrlSafe(endpoint);
    if (!parsed || !isLocalHost(parsed.hostname)) continue;
    uniquePush(origins, parsed.origin);
  }

  for (const origin of origins) {
    const discovered = await probeHealthEndpoint(origin);
    if (discovered) return discovered;
  }

  return null;
}

async function saveLastWorkingEndpoint(endpoint) {
  await chrome.storage.local.set({ [LAST_WORKING_ENDPOINT_KEY]: endpoint });
}

async function loadSettings() {
  const [settings, localSettings] = await Promise.all([
    chrome.storage.sync.get({
      endpoint: DEFAULT_ENDPOINT,
      authToken: ""
    }),
    chrome.storage.local.get({
      [LAST_WORKING_ENDPOINT_KEY]: ""
    })
  ]);

  return {
    endpoint: String(settings.endpoint || DEFAULT_ENDPOINT).trim(),
    authToken: String(settings.authToken || "").trim(),
    lastWorkingEndpoint: String(localSettings[LAST_WORKING_ENDPOINT_KEY] || "").trim()
  };
}

async function sendToQuickAsset(info, tab) {
  const { endpoint, authToken, lastWorkingEndpoint } = await loadSettings();
  const imageUrl = (info.srcUrl || "").trim();
  if (!imageUrl) {
    throw new Error("No image URL found in context menu event.");
  }

  const payload = {
    imageUrl,
    pageUrl: tab?.url || null,
    pageTitle: tab?.title || null
  };

  const headers = {
    "Content-Type": "application/json"
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const endpointCandidates = [];
  const triedEndpoints = [];
  uniquePush(endpointCandidates, lastWorkingEndpoint);
  uniquePush(endpointCandidates, endpoint);

  for (const candidate of endpointCandidates) {
    uniquePush(triedEndpoints, toImportEndpoint(candidate));
  }

  let lastRecoverableError = null;
  let lastHardError = null;

  for (const candidate of triedEndpoints) {
    const result = await requestImport(candidate, payload, headers);
    if (result.ok) {
      await saveLastWorkingEndpoint(toImportEndpoint(result.endpoint));
      return result.data;
    }

    if (shouldAttemptBinaryFallback(result)) {
      lastRecoverableError = result;
      continue;
    }

    lastHardError = result;
    break;
  }

  let discovered = null;
  const discoveredEndpoint = await discoverEndpoint(endpoint, lastWorkingEndpoint);
  if (discoveredEndpoint) {
    discovered = discoveredEndpoint;
  }

  if (discovered && !triedEndpoints.includes(toImportEndpoint(discovered.endpoint))) {
    const retried = await requestImport(toImportEndpoint(discovered.endpoint), payload, headers);
    if (retried.ok) {
      await saveLastWorkingEndpoint(toImportEndpoint(retried.endpoint));
      return retried.data;
    }

    if (shouldAttemptBinaryFallback(retried)) {
      lastRecoverableError = retried;
    } else if (!lastHardError) {
      lastHardError = retried;
    }
  }

  if (!lastHardError && lastRecoverableError) {
    let binaryPayload;
    try {
      binaryPayload = await downloadImageForUpload(imageUrl);
      binaryPayload.pageUrl = tab?.url || "";
      binaryPayload.pageTitle = tab?.title || "";
    } catch (err) {
      throw new Error(`URL 导入失败，且本地下载图片失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const uploadCandidates = [];
    for (const candidate of triedEndpoints) {
      uniquePush(uploadCandidates, toBytesEndpoint(candidate));
    }
    if (discovered?.uploadEndpoint) {
      uniquePush(uploadCandidates, discovered.uploadEndpoint);
    }
    if (discovered?.endpoint) {
      uniquePush(uploadCandidates, toBytesEndpoint(discovered.endpoint));
    }
    uniquePush(uploadCandidates, toBytesEndpoint(DEFAULT_ENDPOINT));

    let lastUploadError = null;
    for (const uploadEndpoint of uploadCandidates) {
      if (!uploadEndpoint) continue;
      const uploadResult = await requestImportBytes(uploadEndpoint, binaryPayload, authToken);
      if (uploadResult.ok) {
        await saveLastWorkingEndpoint(toImportEndpoint(uploadEndpoint));
        return uploadResult.data;
      }

      lastUploadError = uploadResult;
      if (uploadResult.errorType === "http" && uploadResult.status !== 404) {
        throw new Error(uploadResult.message);
      }
    }

    if (lastUploadError) {
      throw new Error(lastUploadError.message);
    }
  }

  if (lastHardError) {
    throw new Error(lastHardError.message);
  }

  if (lastRecoverableError) {
    throw new Error(lastRecoverableError.message);
  }

  throw new Error("Unable to connect to QuickAsset import service.");
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  try {
    await sendToQuickAsset(info, tab);
    setBadge(tab?.id, "OK", "#1f7a1f");
  } catch (err) {
    console.error("QuickAsset image import failed:", err);
    setBadge(tab?.id, "ERR", "#b00020");
  }
});
