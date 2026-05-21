// PDF viewer = thin <iframe> wrapper around the browser's built-in PDF
// reader.
//
// Earlier we shipped a custom PDF.js renderer + selectable text layer to
// support highlight/underline/sticky annotations. The user dropped the
// highlight/underline tools (text-layer selection was sloppy) and moved
// sticky notes to a JSON sidecar. Without those features the only reason to
// keep PDF.js was 划词翻译, which the user accepted trading away in exchange
// for selection precision (the native PDF reader nails it).
//
// API surface kept compatible with app.js:
//   const viewer = new PDFViewer(container);
//   viewer.load(paperId, pdfUrl);
//   viewer.on("onError", fn);   // (errors from <iframe> never fire here)
//   viewer.setScale(...)        // no-op; browser PDF reader has its own UI

class PDFViewer {
  constructor(container) {
    this.container = container;
    this.paperId = "";
    this.callbacks = { onError: null };
    this.container.classList.add("pdfv-container");
    this._renderEmpty();
  }

  on(event, fn) {
    this.callbacks[event] = fn;
  }

  setScale(_scale) {
    // No-op: the embedded browser PDF reader has its own zoom controls.
  }

  async load(paperId, pdfUrl) {
    this.paperId = paperId || "";
    if (!pdfUrl) {
      this._renderEmpty();
      return;
    }
    this.container.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "pdfv-iframe";
    iframe.title = "PDF";
    // 让浏览器原生 PDF 阅读器接管：选择/复制/缩放/搜索全是原生体验。
    iframe.src = pdfUrl;
    this.container.appendChild(iframe);
  }

  _renderEmpty() {
    this.container.innerHTML = '<div class="pdfv-empty">选择一篇文献查看 PDF。</div>';
  }
}

export { PDFViewer };
