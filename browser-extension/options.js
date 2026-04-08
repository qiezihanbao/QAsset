const DEFAULT_ENDPOINT = "http://127.0.0.1:27124/api/import-image";

const endpointInput = document.getElementById("endpoint");
const authTokenInput = document.getElementById("authToken");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

async function restoreOptions() {
  const data = await chrome.storage.sync.get({
    endpoint: DEFAULT_ENDPOINT,
    authToken: ""
  });
  endpointInput.value = data.endpoint || DEFAULT_ENDPOINT;
  authTokenInput.value = data.authToken || "";
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b00020" : "#6b7280";
}

async function saveOptions() {
  const endpoint = endpointInput.value.trim() || DEFAULT_ENDPOINT;
  const authToken = authTokenInput.value.trim();

  if (!/^https?:\/\/.+/i.test(endpoint)) {
    setStatus("接口地址格式不正确", true);
    return;
  }

  await chrome.storage.sync.set({ endpoint, authToken });
  setStatus("已保存");
  setTimeout(() => {
    setStatus("");
  }, 1500);
}

saveBtn.addEventListener("click", () => {
  saveOptions().catch((err) => setStatus(String(err), true));
});

restoreOptions().catch((err) => setStatus(String(err), true));
