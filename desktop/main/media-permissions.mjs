/** Grant only audio capture requested by the trusted desktop main frame.
 * File-scheme origins alone are insufficient: compare the complete document URL. */
export function allowsMicrophone({ webContents, permission, details, mainWindow, desktopUrl, phase }) {
  if (permission !== "media" || !mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents
    || webContents.getURL() !== desktopUrl || details?.isMainFrame !== true) return false;
  if (phase === "request") return details.requestingUrl === desktopUrl && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio";
  return details.mediaType === "audio" && (details.requestingUrl === undefined || details.requestingUrl === desktopUrl);
}
