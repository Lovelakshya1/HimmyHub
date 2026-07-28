export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { malId, ep = '1', lang = 'sub' } = req.query;

  if (!malId) {
    return res.status(400).json({ error: 'malId query param is required' });
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
    'X-Requested-With': 'XMLHttpRequest'
  };

  try {
    // 1. Fetch title & MAL-Sync slug mapping
    let title = '';
    let malSyncSlug = '';

    try {
      const syncRes = await fetch(`https://api.malsync.moe/mal/anime/${malId}`);
      if (syncRes.ok) {
        const syncData = await syncRes.json();
        title = syncData.title || '';
        const sites = syncData.Sites || {};
        if (sites.Anikoto) {
          const k = Object.keys(sites.Anikoto)[0];
          if (k) malSyncSlug = sites.Anikoto[k].identifier || '';
        }
        if (!malSyncSlug && sites.Zoro) {
          const k = Object.keys(sites.Zoro)[0];
          if (k) malSyncSlug = (sites.Zoro[k].identifier || '').replace(/-\d+$/, '');
        }
      }
    } catch (e) {
      console.warn('MAL-Sync error:', e.message);
    }

    if (!title) {
      try {
        const zipRes = await fetch(`https://api.ani.zip/mappings?mal_id=${malId}`);
        if (zipRes.ok) {
          const zipData = await zipRes.json();
          title = zipData.titles?.en || zipData.titles?.['x-jat'] || '';
        }
      } catch (e) {
        console.warn('AniZip error:', e.message);
      }
    }

    // 2. Resolve watch slug
    let slug = malSyncSlug;
    if (!slug) {
      const searchUrl = `https://anikototv.to/filter?keyword=${encodeURIComponent(title || malId)}`;
      const searchRes = await fetch(searchUrl, { headers });
      if (searchRes.ok) {
        const html = await searchRes.text();
        
        // Target film_list-wrap or film_list container to exclude header/sidebar/spotlight
        const searchSectionMatch = html.match(/class="film_list-wrap[\s\S]*?(?:<\/section>|<div class="sidebar"|<aside)/i) ||
                                    html.match(/class="film-list[\s\S]*?(?:<\/section>|<div class="sidebar"|<aside)/i) ||
                                    [html];
        const sectionHtml = searchSectionMatch[0];

        const matches = [...sectionHtml.matchAll(/href="https?:\/\/[^/]+\/watch\/([^"/]+)"/g)]
          .concat([...sectionHtml.matchAll(/href="\/watch\/([^"/]+)"/g)]);
          
        if (matches.length > 0) {
          slug = matches[0][1];
        }
      }
    }

    if (!slug) {
      return res.status(404).json({ error: 'Could not resolve Anikoto slug for MAL ID ' + malId });
    }

    // 3. Fetch watch page HTML to extract internal animeId (#watch-main data-id)
    const watchUrl = `https://anikototv.to/watch/${slug}/ep-${ep}`;
    let watchRes = await fetch(watchUrl, { headers });
    let html = '';
    if (watchRes.ok) html = await watchRes.text();

    if (!html) {
      const altUrl = `https://anikoto.net/watch/${slug}/ep-${ep}`;
      const altRes = await fetch(altUrl, { headers });
      if (altRes.ok) html = await altRes.text();
    }

    // Parse animeId specifically from #watch-main data-id
    const animeIdMatch = html.match(/id\s*=\s*"watch-main"[^>]*\bdata-id\s*=\s*"(\d+)"/) ||
                       html.match(/data-id\s*=\s*"(\d+)"[^>]*id\s*=\s*"watch-main"/);
    const animeId = animeIdMatch?.[1] || '';

    // Extract episode data-id/data-ids
    let epDataIds = '';
    const epMatch = html.match(new RegExp(`data-num="${ep}"[^>]*data-ids="([^"]+)"`)) ||
                    html.match(new RegExp(`data-num="${ep}"[^>]*data-id="([^"]+)"`));
    if (epMatch) {
      epDataIds = epMatch[1];
    }

    // Fallback: AJAX episode list if epDataIds not found directly
    if (!epDataIds && animeId) {
      try {
        const epListUrl = `https://anikototv.to/ajax/episode/list/${animeId}`;
        const epListRes = await fetch(epListUrl, { headers });
        if (epListRes.ok) {
          const epListData = await epListRes.json();
          const epListHtml = epListData.result || '';
          const m = epListHtml.match(new RegExp(`data-num="${ep}"[^>]*data-ids="([^"]+)"`)) ||
                    epListHtml.match(new RegExp(`data-num="${ep}"[^>]*data-id="([^"]+)"`));
          if (m) epDataIds = m[1];
        }
      } catch (e) {
        console.warn('AJAX ep list error:', e.message);
      }
    }

    // 4. Fetch server list AJAX if epDataIds found
    let s2EmbedUrl = null;
    let s5EmbedUrl = null;

    if (epDataIds) {
      try {
        const serverListUrl = `https://anikototv.to/ajax/server/list?servers=${epDataIds}`;
        const serverListRes = await fetch(serverListUrl, { headers });
        if (serverListRes.ok) {
          const serverData = await serverListRes.json();
          const serverHtml = serverData.result || '';

          // Parse s-2 and s-5 server linkIds
          const s2Match = serverHtml.match(/data-sv-id="s-2"[^>]*data-link-id="([^"]+)"/) ||
                          serverHtml.match(/data-link-id="([^"]+)"[^>]*data-sv-id="s-2"/);
          const s5Match = serverHtml.match(/data-sv-id="s-5"[^>]*data-link-id="([^"]+)"/) ||
                          serverHtml.match(/data-link-id="([^"]+)"[^>]*data-sv-id="s-5"/);

          const s2LinkId = s2Match?.[1];
          const s5LinkId = s5Match?.[1];

          // Fetch resolved embed URLs via /ajax/server?get={linkId}
          if (s2LinkId) {
            const s2Res = await fetch(`https://anikototv.to/ajax/server?get=${s2LinkId}&sv=s-2`, { headers });
            if (s2Res.ok) {
              const s2Json = await s2Res.json();
              s2EmbedUrl = s2Json.result?.url || null;
            }
          }

          if (s5LinkId) {
            const s5Res = await fetch(`https://anikototv.to/ajax/server?get=${s5LinkId}&sv=s-5`, { headers });
            if (s5Res.ok) {
              const s5Json = await s5Res.json();
              s5EmbedUrl = s5Json.result?.url || null;
            }
          }
        }
      } catch (e) {
        console.warn('Server list AJAX error:', e.message);
      }
    }

    // Constructed routes as fallback if direct AJAX embed URLs couldn't be fetched
    const fallbackS2 = animeId ? `https://megaplay.buzz/stream/s-2/${animeId}/${lang}?ep=${ep}` : null;
    const fallbackS5 = animeId ? `https://megaplay.buzz/stream/s-5/${animeId}/${lang}?ep=${ep}` : null;
    const malUrl = `https://megaplay.buzz/stream/mal/${malId}/${ep}/${lang}`;

    return res.status(200).json({
      success: true,
      malId,
      title,
      slug,
      animeId,
      epDataIds,
      urls: {
        mal: malUrl,
        s2: s2EmbedUrl || fallbackS2,
        s5: s5EmbedUrl || fallbackS5,
        web: `https://anikototv.to/watch/${slug}/ep-${ep}`
      }
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
