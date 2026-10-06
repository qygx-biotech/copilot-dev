'use strict';
// Reuses BioDesign's configured OSS client. No paper/library object prefix,
// anonymous ACL, model-controlled key or new conversation store is involved.
function ossStore(client) {
  return {
    async put(key, text) {
      await client.put(`runtime/context-archives/v1/${key}`, Buffer.from(text), { headers: { 'x-oss-object-acl': 'private', 'Content-Type': 'text/plain; charset=utf-8' } });
    },
    async claim(key, text) {
      try {
        await client.put(`runtime/context-archives/v1/${key}`, Buffer.from(text), { headers: {
          'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private', 'Content-Type': 'application/json' } });
        return true;
      } catch (error) {
        if (error.code === 'FileAlreadyExists') return false;
        throw error;
      }
    },
    async get(key) {
      const result = await client.get(`runtime/context-archives/v1/${key}`);
      return Buffer.from(result.content).toString('utf8');
    }
  };
}
module.exports = { ossStore };
