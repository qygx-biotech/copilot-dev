import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";

// Preserve the renderer's existing PDF.js integration while loading the
// maintained ESM distribution from packaged local assets.
globalThis.pdfjsLib = pdfjsLib;
