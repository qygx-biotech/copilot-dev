(function exposeImageComposer(root) {
  "use strict";
  const api = root.BioDesignChatImages;
  const fail = key => Object.assign(new Error(key), { code: "IMAGE_PREPARE", translationKey: key });
  async function prepareImage(file) {
    if (!api.mimeTypes.includes(file.type)) throw fail("imageUnsupported");
    if (!file.size || file.size > api.limits.sourceBytes) throw fail("imageTooLarge");
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { throw fail("imageUnreadable"); }
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > api.limits.pixels) throw fail("imageTooLarge");
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, api.limits.edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const draw = () => { const context = canvas.getContext("2d"); context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); };
      draw();
      let dataUrl = canvas.toDataURL("image/png");
      if (!api.dataUrlInfo(dataUrl)) {
        for (let attempt = 0; attempt < 5; attempt++) {
          dataUrl = canvas.toDataURL("image/jpeg", 0.9 - attempt * 0.08);
          if (api.dataUrlInfo(dataUrl)) break;
          canvas.width = Math.max(1, Math.round(canvas.width * 0.8)); canvas.height = Math.max(1, Math.round(canvas.height * 0.8)); draw();
        }
      }
      if (!api.dataUrlInfo(dataUrl)) throw fail("imageTooLarge");
      const thumbScale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * thumbScale)); canvas.height = Math.max(1, Math.round(bitmap.height * thumbScale)); draw();
      const thumbnail = canvas.toDataURL("image/jpeg", 0.75);
      return { id: crypto.randomUUID(), name: api.safeName(file.name), dataUrl, thumbnail };
    } finally { bitmap.close(); }
  }
  function create({ form, input, button, previews, status, translate, isBusy, onChange = () => {} }) {
    let images = [], busy = false, generation = 0, dragDepth = 0;
    function render() {
      previews.replaceChildren(); previews.hidden = !images.length;
      for (const entry of images) {
        const item = document.createElement("div"); item.className = "chat-image-preview";
        const image = document.createElement("img"); image.src = entry.thumbnail; image.alt = entry.name; image.title = entry.name;
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
        remove.setAttribute("aria-label", translate("removeChatImage", { name: entry.name })); remove.disabled = isBusy() || busy;
        remove.addEventListener("click", () => { if (!isBusy() && !busy) { images = images.filter(value => value.id !== entry.id); render(); } });
        item.append(image, remove); previews.append(item);
      }
      button.disabled = isBusy() || busy || images.length >= api.limits.count;
      input.disabled = isBusy() || busy;
      onChange({ count: images.length, preparing: busy });
    }
    async function addFiles(files) {
      if (isBusy() || busy) return;
      const selected = Array.from(files || []);
      if (!selected.length) return;
      status.textContent = "";
      if (selected.length + images.length > api.limits.count) { status.textContent = translate("imageCountLimit"); return; }
      busy = true; const version = generation; render();
      try {
        const added = [];
        for (const file of selected) { added.push(await prepareImage(file)); if (version !== generation) return; }
        images.push(...added);
      } catch (error) { if (version === generation) status.textContent = translate(error.translationKey || "imageUnreadable"); }
      finally { if (version === generation) { busy = false; input.value = ""; render(); } }
    }
    button.addEventListener("click", () => { if (!button.disabled) input.click(); });
    input.addEventListener("change", () => addFiles(input.files));
    const containsFiles = event => Array.from(event.dataTransfer?.types || []).includes("Files");
    form.addEventListener("dragenter", event => { if (containsFiles(event)) { event.preventDefault(); dragDepth++; if (!isBusy()) form.classList.add("image-drop-active"); } });
    form.addEventListener("dragover", event => { if (containsFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = isBusy() || busy ? "none" : "copy"; } });
    form.addEventListener("dragleave", event => { if (containsFiles(event) && --dragDepth <= 0) { dragDepth = 0; form.classList.remove("image-drop-active"); } });
    form.addEventListener("drop", event => { if (!containsFiles(event)) return; event.preventDefault(); event.stopPropagation(); dragDepth = 0; form.classList.remove("image-drop-active"); void addFiles(event.dataTransfer.files); });
    // Dropping a file outside the composer must not navigate away from the app.
    document.addEventListener("dragover", event => { if (containsFiles(event)) event.preventDefault(); });
    document.addEventListener("drop", event => { if (containsFiles(event)) event.preventDefault(); });
    render();
    return { addFiles, render, get images() { return images.slice(); }, get preparing() { return busy; },
      clear() { generation++; busy = false; images = []; status.textContent = ""; input.value = ""; form.classList.remove("image-drop-active"); render(); } };
  }
  root.BioDesignChatImageComposer = Object.freeze({ create, prepareImage });
})(globalThis);
