# Side Chat image understanding

Side Chat accepts up to four PNG, JPEG, or WebP images through **Add images**, clipboard paste (including Mac screenshots), or a drop onto the message box. Small previews appear before sending, with individual remove buttons. Images can be sent with a question or on their own. Ordinary text paste still works.

When editing the latest message, its images appear with remove buttons. Upload, paste, or drop more images in the editor, then **Save and regenerate**. Cancel discards both text and image changes. These composer changes use the existing image-understanding endpoint and do not require another backend deployment.

The request runs in this order:

1. Prepare and save the attached images in the local conversation.
2. Call authenticated `POST /api/chat/understand-images`. Requesty receives the user's question and `image_url` content containing base64 image data URLs with MIME types.
3. Combine the returned observations with the typed question, then run the existing knowledge preparation and Side Chat answer process. The answer streams when the FC streaming runtime is enabled.

The image call is labeled `image_understanding` in Requesty metadata and `image-understanding` in the app's Debug Console. A visible activity step reports when images are being read. Image data, prompts, and model observations are excluded from operational logs.

## Deploy

Upload **`out/preflight-knowledge-sync/alibaba-fc-images-streaming.zip`** to the existing dev function. It includes the earlier paper-card, citation, and streaming fixes as well as image understanding.

- `REQUESTY_IMAGE_MODEL`: optional vision-capable model identifier. If unset, image reading uses `REQUESTY_MODEL`; that model must support images. Keep the existing Requesty key and authentication settings.
- Image understanding works with the existing built-in `index.handler` deployment or the custom HTTP runtime. To retain streaming, use the [streaming settings](STREAMING_DEPLOYMENT.md): `custom.debian12`, `/code/bootstrap`, port `9000`, timeout `300` seconds.
- Keep the existing endpoint so the rebuilt app contacts the updated function. A different endpoint requires updating `ALIBABA_FC_URL` and rebuilding the app.

Before deployment, the new app displays an actionable error when an image request reaches an older backend; it does not silently omit the images. Text-only requests remain compatible.

## Storage and limits

- Original input: up to 10 MiB and 40 megapixels per image.
- The app prepares a static image up to 2048 pixels on its longest edge and 700 KiB per image, plus a small thumbnail. Readability of very dense figures may improve if the user crops the relevant area first. Source files are not modified.
- Prepared image data is stored locally in `.biodesign/chat/attachments/<id>.json`. Conversation records contain attachment references, thumbnails, and the completed interpretation; full image data is not included in subsequent knowledge/answer requests.
- Editing the latest question interprets only the images retained or added in the editor. Removing all images also removes their previous interpretation from that turn. Follow-up messages receive the previous interpretation as conversation context.
- A failed, incomplete, rate-limited, or cancelled image call does not start knowledge preparation or a final answer. The saved image remains available for retry. Workspace changes discard pending attachment previews and cancel the active request.

## Verify

Sign in to the rebuilt Mac app. Copy a screenshot to the clipboard with Control–Shift–Command–4, select an area, then click Side Chat and press Command–V. Confirm a small preview appears. Add another image by upload or drop and send a question. Observe image reading before knowledge preparation and the final streamed answer. Edit the latest message, remove an image, paste a replacement, and save. Reopen the workspace to confirm the edited attachments persist.

The automated tests use local image and provider fixtures. A live provider check requires deploying this ZIP and configuring a vision-capable model.

Reference: [Requesty image understanding](https://docs.requesty.ai/features/image-understanding).
