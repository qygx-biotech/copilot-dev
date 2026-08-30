export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") {
      return Response.json({
        ok: true,
        service: "BioDesign Copilot legacy Worker",
        retired: true,
        activeBackend: "Alibaba Function Compute",
      });
    }
    return Response.json(
      {
        error: "Backend retired",
        message: "BioDesign Electron cloud requests are served only by the authenticated Alibaba Function Compute backend.",
      },
      { status: 410 }
    );
  },
};
