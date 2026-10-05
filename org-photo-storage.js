(() => {
  const bucket = 'org-photos';
  const prefix = 'org-photo:';
  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/svg+xml']);
  const signed = new Map();
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="#eef1f3"/><text x="36" y="42" text-anchor="middle" fill="#52636b" font-size="12">Photo</text></svg>');
  let client;
  let isAdmin = () => false;
  function path(value) {
    if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
    const result = value.slice(prefix.length);
    return /^photos\/[a-f0-9-]+\.(webp|jpg|png)$/.test(result) ? result : null;
  }
  function slots(state) {
    const result = [];
    for (const person of state.people || []) result.push({ owner: person, key: 9 });
    for (const department of state.departments || []) result.push({ owner: department, key: 2 });
    if (state.siteSettings) result.push({ owner: state.siteSettings, key: 'brandImage' });
    return result;
  }
  function refs(state) {
    return [...new Set(slots(state).map(slot => path(slot.owner[slot.key])).filter(Boolean))];
  }
  function acceptUrls(entries) {
    for (const entry of entries || []) {
      if (entry.error || !path(prefix + entry.path) || !entry.signedUrl) continue;
      const parsed = new URL(entry.signedUrl, window.ORG_CHART_CONFIG?.url);
      if (parsed.protocol !== 'https:') continue;
      signed.set(entry.path, { url: parsed.toString(), expires: Date.now() + 25 * 60 * 1000 });
    }
  }
  async function ensure(state, entries) {
    if (entries) acceptUrls(entries);
    const missing = refs(state).filter(ref => !signed.has(ref) || signed.get(ref).expires <= Date.now());
    if (!missing.length || entries) return;
    for (let i = 0; i < missing.length; i += 100) {
      const { data, error } = await client.storage.from(bucket).createSignedUrls(missing.slice(i, i + 100), 3600);
      if (error) throw new Error('Could not load private photos. Check the photo storage setup and your connection.');
      acceptUrls(data);
    }
  }
  async function compress(file) {
    if (!imageTypes.has(file.type)) throw new Error('Choose a JPG, PNG, or WebP image.');
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose an image smaller than 25 MB.');
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      image.src = objectUrl;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('The image could not be read.');
      const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      let output;
      for (const quality of [.85, .7, .55]) {
        output = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (output && output.size <= 180 * 1024) break;
      }
      if (!output || output.size > 512 * 1024) throw new Error('Could not optimize this image. Choose a smaller JPG, PNG, or WebP.');
      return output;
    } finally { URL.revokeObjectURL(objectUrl); }
  }
  async function upload(file) {
    if (!client || !isAdmin()) throw new Error('Only directory administrators can upload photos.');
    const optimized = await compress(file);
    const extension = optimized.type === 'image/webp' ? 'webp' : optimized.type === 'image/png' ? 'png' : 'jpg';
    const photoPath = `photos/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from(bucket).upload(photoPath, optimized, {
      contentType: optimized.type, cacheControl: '3600', upsert: false,
    });
    if (error) throw new Error(`Photo upload failed: ${error.message}. Check the photo storage setup.`);
    const { data, error: signedError } = await client.storage.from(bucket).createSignedUrls([photoPath], 3600);
    if (signedError) throw new Error('The photo uploaded but could not be displayed. Your employee record was not changed.');
    acceptUrls(data);
    if (!signed.has(photoPath)) throw new Error('The photo uploaded but could not be displayed. Your employee record was not changed.');
    return prefix + photoPath;
  }
  window.OrgPhotos = {
    configure(value, canUpload) { client = value; isAdmin = canUpload; },
    url(value) { const ref = path(value); return ref ? signed.get(ref)?.url || placeholder : value || ''; },
    ensure, acceptUrls, upload, compress, slots, refs,
    clear() { signed.clear(); },
    async moveEmbedded(state, progress) {
      const embedded = slots(state).filter(slot => typeof slot.owner[slot.key] === 'string' && slot.owner[slot.key].startsWith('data:image/'));
      const moved = new Map();
      let index = 0;
      for (const slot of embedded) {
        const value = slot.owner[slot.key];
        if (!moved.has(value)) {
          const response = await fetch(value);
          moved.set(value, await upload(await response.blob()));
        }
        slot.owner[slot.key] = moved.get(value);
        progress(++index, embedded.length);
      }
      return embedded.length;
    },
  };
  window.readImageFile = async (input, fallback) => {
    const file = input?.files?.[0];
    if (!file) return fallback || '';
    try { return await upload(file); }
    catch (error) { alert(error.message); throw error; }
  };
})();
