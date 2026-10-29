// Frozen fixtures follow the existing demo product names and grid prices.
const products = [
  { name: "黄金 ETF", code: "518880", symbol: "Au", price: 6.92, share: 1500, short: false },
  { name: "沪深 300 ETF", code: "510300", symbol: "300", price: 4.12, share: 2000, short: false },
  { name: "创业板 ETF", code: "159915", symbol: "CY", price: 2.78, share: 1800, short: false },
  { name: "科创 50 ETF", code: "588000", symbol: "50", price: 1.16, share: 2400, short: false },
  { name: "红利 ETF", code: "510880", symbol: "HL", price: 3.42, share: 1600, short: false },
  { name: "纳指 ETF", code: "513100", symbol: "ND", price: 1.79, share: 2200, short: true },
];

const themes = {
  azure: { name: "晴空蓝", description: "清爽的冷白工作区，让数据成为视觉中心。", notes: "冷白主背景 / 蓝色焦点 / 紧凑圆角 / 清晰分层", rationale: "适合高频查看与操作。白色导航和冷灰工作区形成清晰分层，蓝色只用于选中态和主操作。" },
  jade: { name: "松石绿", description: "柔和的雾绿与松石色，让长时间浏览更从容。", notes: "雾绿主背景 / 松石色导航 / 柔和大圆角 / 轻盈阴影", rationale: "适合偏好柔和界面的日常使用。雾绿导航、较大圆角和轻阴影，让信息密集的工作台更舒展。" },
  porcelain: { name: "暖瓷橙", description: "暖白底色与琥珀细节，让每一行数据沉静有序。", notes: "暖瓷白主背景 / 琥珀色强调 / 细线与小圆角 / 衬线数字", rationale: "适合偏好温暖、克制的界面。暖白底色搭配琥珀色操作，衬线数字和细边框带来账簿般的秩序感。" },
};
const themeKeys = Object.keys(themes);
const params = new URLSearchParams(location.search);
let currentTheme = "azure";
let filter = "all";
let selected = products[0];
let toastTimer;
let framesReady = false;

function setTheme(key, updateUrl = true) {
  if (!Object.hasOwn(themes, key)) key = "azure";
  currentTheme = key;
  document.body.dataset.theme = key;
  document.querySelectorAll("[data-choice]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.choice === key)));
  document.getElementById("active-title").textContent = themes[key].name;
  document.getElementById("active-description").textContent = themes[key].description;
  document.getElementById("design-notes").textContent = themes[key].notes;
  document.getElementById("cycle-theme").setAttribute("aria-label", `当前${themes[key].name}，切换下一款皮肤`);
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set("theme", key);
    history.replaceState(null, "", url);
  }
  // Preview preferences are local to this demo; storage may be disabled by the browser.
  if (!params.has("embed")) {
    try { localStorage.setItem("fitgrid-theme-demo", key); } catch { /* URL remains shareable without storage. */ }
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function renderProducts() {
  const query = document.getElementById("search").value.trim().toLowerCase();
  const visible = products.filter(product => `${product.name} ${product.code}`.toLowerCase().includes(query) && (filter === "all" || (filter === "short" ? product.short : !product.short)));
  document.getElementById("product-rows").innerHTML = visible.map(product => `
    <tr class="${product === selected ? "selected" : ""}">
      <td><div class="product-cell"><span class="product-avatar" aria-hidden="true">${product.symbol}</span><div><button class="product-name" data-product="${product.code}" aria-label="查看${product.name}配置" aria-pressed="${product === selected}">${product.name}</button><span class="product-code">${product.code}</span></div></div></td>
      <td><span class="badge ${product.short ? "short" : ""}">${product.short ? "做空" : "做多"}</span></td>
      <td>${product.price.toFixed(4)}</td><td>${product.share.toLocaleString("en-US")}.00</td><td><span class="row-arrow" aria-hidden="true">›</span></td>
    </tr>`).join("");
  document.getElementById("result-count").textContent = `显示 ${visible.length} / ${products.length} 个产品`;
  document.getElementById("empty").hidden = visible.length !== 0;
}

function prices(product, index) {
  // Visual ladder only: short strategies reverse the buy/sell sides.
  const high = product.price * (1 - index * .05);
  const low = product.price * (1 - (index + 1) * .05);
  return { buy: product.short ? high : low, sell: product.short ? low : high };
}

function renderDetails() {
  document.getElementById("detail-avatar").textContent = selected.symbol;
  document.getElementById("detail-title").textContent = selected.name;
  document.getElementById("detail-code").textContent = `${selected.code} · ETF`;
  document.getElementById("detail-price").textContent = selected.price.toFixed(4);
  document.getElementById("detail-share").innerHTML = `${selected.share.toLocaleString("en-US")}<small>.00</small>`;
  const direction = document.getElementById("detail-direction");
  direction.textContent = selected.short ? "做空" : "做多";
  direction.classList.toggle("short", selected.short);
  document.getElementById("ladder").innerHTML = [0, 1, 2].map(index => {
    const { buy, sell } = prices(selected, index);
    return `<div class="ladder-row"><span>${String(index + 1).padStart(2, "0")}</span><span class="ladder-price" aria-label="买入价 ${buy.toFixed(4)}">${buy.toFixed(4)}</span><span class="ladder-price sell" aria-label="卖出价 ${sell.toFixed(4)}">${sell.toFixed(4)}</span></div>`;
  }).join("");
}

document.querySelectorAll("[data-choice]").forEach(button => button.addEventListener("click", () => {
  setTheme(button.dataset.choice);
  if (!document.getElementById("comparison").hidden) toggleComparison(false);
}));
document.getElementById("cycle-theme").addEventListener("click", () => {
  setTheme(themeKeys[(themeKeys.indexOf(currentTheme) + 1) % themeKeys.length]);
  showToast(`已切换为${themes[currentTheme].name}`);
});
document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  renderProducts();
}));
document.getElementById("search").addEventListener("input", renderProducts);
document.getElementById("product-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-product]");
  if (!button) return;
  selected = products.find(product => product.code === button.dataset.product);
  // Keep the existing DOM button and its keyboard focus while updating selection.
  document.querySelectorAll("[data-product]").forEach(item => {
    const active = item === button;
    item.setAttribute("aria-pressed", String(active));
    item.closest("tr").classList.toggle("selected", active);
  });
  renderDetails();
});
document.getElementById("refresh").addEventListener("click", () => showToast("已刷新 · 当前为固定演示数据"));
document.querySelectorAll("[data-notice]").forEach(button => button.addEventListener("click", () => showToast(`${button.dataset.notice}：此处为视觉预览，正式功能待选定皮肤后接入`)));

const dialog = document.getElementById("detail-dialog");
document.getElementById("detail-action").addEventListener("click", () => {
  document.getElementById("dialog-title").textContent = `${selected.name} · 网格明细`;
  document.getElementById("dialog-rows").innerHTML = [0, 1, 2].map(index => {
    const { buy, sell } = prices(selected, index);
    return `<tr><td>${index + 1}</td><td>${buy.toFixed(4)}</td><td>${sell.toFixed(4)}</td><td>${(Math.abs(sell - buy) / buy * 100).toFixed(2)}%</td></tr>`;
  }).join("");
  dialog.showModal();
});
document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => { if (event.target === dialog && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > dialog.offsetWidth || event.offsetY > dialog.offsetHeight)) dialog.close(); });

function toggleComparison(show) {
  const comparison = document.getElementById("comparison");
  document.getElementById("compare-toggle").setAttribute("aria-pressed", String(show));
  document.getElementById("compare-toggle").querySelector("span").textContent = show ? "返回单款预览" : "三款并排对比";
  document.getElementById("single-preview").hidden = show;
  comparison.hidden = !show;
  if (show && !framesReady) {
    comparison.innerHTML = themeKeys.map(key => `<section class="comparison-card"><header class="comparison-heading"><div><strong>${themes[key].name}</strong><p>${themes[key].notes.split(" / ").slice(0, 2).join(" · ")}</p></div><button data-enlarge="${key}">放大预览 ↗</button></header><div class="frame-viewport"><iframe tabindex="-1" loading="lazy" title="${themes[key].name}皮肤预览" src="./?theme=${key}&embed=1"></iframe></div><div class="comparison-notes">${themes[key].rationale}</div></section>`).join("");
    const resize = new ResizeObserver(entries => entries.forEach(entry => {
      const scale = entry.contentRect.width / 1240;
      entry.target.style.height = `${1000 * scale}px`;
      entry.target.querySelector("iframe").style.transform = `scale(${scale})`;
    }));
    comparison.querySelectorAll(".frame-viewport").forEach(viewport => resize.observe(viewport));
    framesReady = true;
  }
}
document.getElementById("compare-toggle").addEventListener("click", () => toggleComparison(document.getElementById("comparison").hidden));
document.getElementById("comparison").addEventListener("click", event => {
  const button = event.target.closest("[data-enlarge]");
  if (button) { setTheme(button.dataset.enlarge); toggleComparison(false); }
});

let initialTheme = params.get("theme");
if (!initialTheme) {
  try { initialTheme = localStorage.getItem("fitgrid-theme-demo"); } catch { /* Default to azure. */ }
}
if (params.has("embed")) document.body.classList.add("embed");
setTheme(initialTheme, false);
renderProducts();
renderDetails();
if (params.get("view") === "compare" && !params.has("embed")) toggleComparison(true);
