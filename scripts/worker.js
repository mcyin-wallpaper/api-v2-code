import { createClient } from '@supabase/supabase-js';
let _supabase = null;
function getSupabase(env) {
    if (!_supabase) {
        _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },
        });
    }
    return _supabase;
}
async function fetchBingJson(url) {
    const response = await fetch(url, {
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        },
    });
    const rawText = await response.text();
    if (!response.ok) {
        throw new Error(`Bing 接口请求失败：HTTP ${response.status}，响应：${rawText.slice(0, 200)}`);
    }
    try {
        return JSON.parse(rawText);
    } catch {
        throw new Error(`Bing 接口返回了非 JSON 内容（HTTP ${response.status}）：${rawText.slice(0, 200) || '(空响应)'}`);
    }
}
async function fetchBingImages(mkt = 'zh-CN', idxList = [0, 7]) {
    const domain = mkt === 'zh-CN' ? 'cn.bing.com' : 'www.bing.com';
    const url1 = `https://www.bing.com/HPImageArchive.aspx?format=js&idx=${idxList[0]}&n=8&mkt=${mkt}`;
    const url2 = `https://www.bing.com/HPImageArchive.aspx?format=js&idx=${idxList[1]}&n=8&mkt=${mkt}`;
    const [data1, data2] = await Promise.all([fetchBingJson(url1), fetchBingJson(url2)]);
    const mergedImages = [...(data1.images || []), ...(data2.images || [])];
    const images = Array.from(
        new Map(mergedImages.map(img => [`${img.urlbase}${img.enddate}`, img])).values()
    ).map(img => ({
        ...img,
        uhdurl: `https://${domain}${img.urlbase}_UHD.jpg`,
        whurl: `https://${domain}${img.urlbase}_UHD.jpg&w=3840&h=2160&rs=1&c=1`,
    })).sort((a, b) => b.enddate.localeCompare(a.enddate));
    return { images, sourceUrls: [url1, url2] };
}
async function updateWallpapers(env, addCorsHeaders = null) {
    const supabase = getSupabase(env);
    try {
        const { images: uniqueImages } = await fetchBingImages('zh-CN', [0, 7]);
        const results = { inserted: 0, skipped: 0, errors: [] };
        if (uniqueImages.length === 0) {
            return addCorsHeaders ? addCorsHeaders(Response.json(results)) : results;
        }
        const wallpapersToUpsert = uniqueImages.map(img => ({
            enddate: img.enddate,
            url: img.uhdurl,
            copyright: img.copyright,
            title: img.title,
            views: 0
        }));
        const { data: insertedData, error: upsertError } = await supabase
            .from(env.SUPABASE_TABLE_NAME)
            .upsert(wallpapersToUpsert, { onConflict: 'enddate', ignoreDuplicates: true })
            .select('enddate');
        if (upsertError) {
            results.errors.push({ error: upsertError.message });
        } else {
            results.inserted = insertedData ? insertedData.length : 0;
            results.skipped = uniqueImages.length - results.inserted;
        }
        return addCorsHeaders ? addCorsHeaders(Response.json(results)) : results;
    } catch (error) {
        const errorResult = { error: error.message };
        return addCorsHeaders ? addCorsHeaders(Response.json(errorResult, { status: 500 })) : errorResult;
    }
}
async function WallpaperData(env, keyword = "", pageNumber = 1, pageSize = 30, mode = "search") {
    const supabase = getSupabase(env);
    const searchKeyword = `%${keyword}%`;
    if (mode === "views") {
        const { data, error } = await supabase
            .rpc('increment_wallpaper_views', { p_enddate: keyword });
        if (error) {
            return Response.json({ error: error.message }, { status: 400 });
        }
        if (!Array.isArray(data) || data.length === 0) {
            return Response.json({ error: "No data found for the given enddate" }, { status: 404 });
        }
        return Response.json({ output: data });
    }
    const range = {
        a: (pageNumber - 1) * pageSize,
        b: (pageNumber - 1) * pageSize + pageSize
    };
    let query = supabase
        .from(env.SUPABASE_TABLE_NAME)
        .select('*');
    if (mode === "enddate") {
        query = query.eq('enddate', keyword);
    } else {
        query = query.or(`title.ilike.${searchKeyword},copyright.ilike.${searchKeyword},enddate.ilike.${searchKeyword}`);
    }
    const { data, error } = await query
        .order('enddate', { ascending: false })
        .range(range.a, range.b);
    if (error) {
        return Response.json({ error: error.message }, { status: 400 });
    }
    const Previous_Page = Math.max(pageNumber - 1, 1);
    const Page = pageNumber;
    const Next_Page = data.length <= pageSize ? pageNumber : pageNumber + 1;
    return Response.json({ Previous_Page, Page, Next_Page, output: data.slice(0, pageSize) || [] });
}
export default {
    async scheduled(controller, env, ctx) {
        console.log("cron processed");
        const result = await updateWallpapers(env);
        console.log("Update result:", result);
    },
    async fetch(request, env, ctx) {
        const { pathname, searchParams } = new URL(request.url);
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        };
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders,
            });
        }
        const addCorsHeaders = (response) => {
            const newHeaders = new Headers(response.headers);
            Object.entries(corsHeaders).forEach(([key, value]) => {
                newHeaders.set(key, value);
            });
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders,
            });
        };
        if (pathname === "/wallpaper/search" || pathname === "/api/search") {
            if (request.method === "GET") {
                const keyword = searchParams.get('search') || "";
                const pageNumber = Math.max(Number(searchParams.get('page')) || 1, 1);
                const pageSize = Math.min(Math.max(Number(searchParams.get('limit')) || 30, 1), 100);
                const mode = "search";
                const response = await WallpaperData(env, keyword, pageNumber, pageSize, mode);
                return addCorsHeaders(response);
            }
            if (request.method === "POST") {
                const body = await request.json().catch(() => ({}));
                const { search, page, limit } = body;
                const keyword = search || "";
                const pageNumber = Math.max(Number(page) || 1, 1);
                const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 100);
                const mode = "search";
                const response = await WallpaperData(env, keyword, pageNumber, pageSize, mode);
                return addCorsHeaders(response);
            }
        }
        if (pathname === "/wallpaper/detail" || pathname === "/api/detail") {
            if (request.method === "GET") {
                const keyword = searchParams.get('enddate') || "";
                const mode = "enddate";
                const response = await WallpaperData(env, keyword, 1, 1, mode);
                return addCorsHeaders(response);
            }
            if (request.method === "POST") {
                const body = await request.json().catch(() => ({}));
                const { enddate } = body;
                const keyword = enddate || "";
                const mode = "enddate";
                const response = await WallpaperData(env, keyword, 1, 1, mode);
                return addCorsHeaders(response);
            }
        }
        if (pathname === "/wallpaper/view" || pathname === "/api/view") {
            if (request.method === "GET") {
                const keyword = searchParams.get('enddate') || "";
                const mode = "views";
                const response = await WallpaperData(env, keyword, 1, 1, mode);
                return addCorsHeaders(response);
            }
            if (request.method === "POST") {
                const body = await request.json().catch(() => ({}));
                const { enddate } = body;
                const keyword = enddate || "";
                const mode = "views";
                const response = await WallpaperData(env, keyword, 1, 1, mode);
                return addCorsHeaders(response);
            }
        }
        if (pathname === "/wallpaper/update" || pathname === "/api/update") {
            if (request.method === "GET" || request.method === "POST") {
                return await updateWallpapers(env, addCorsHeaders);
            }
        }
        if (pathname === "/wallpaper/bing-hp" || pathname === "/api/bing-hp") {
            if (request.method === "GET" || request.method === "POST") {
                let mkt = 'zh-CN';
                if (request.method === "POST") {
                    const body = await request.json().catch(() => ({}));
                    mkt = body.mkt || 'zh-CN';
                } else {
                    mkt = searchParams.get('mkt') || 'zh-CN';
                }
                try {
                    const { images, sourceUrls } = await fetchBingImages(mkt);
                    const response = new Response(JSON.stringify({
                        images,
                        totalImages: images.length,
                        mkt: mkt,
                        sourceUrls: sourceUrls,
                        timestamp: Date.now()
                    }, null, 2), {
                        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
                    });
                    return addCorsHeaders(response);
                } catch (error) {
                    console.error({ message: 'Error processing request', error: error.message });
                    const response = new Response(JSON.stringify({
                        error: error.message,
                        timestamp: Date.now()
                    }, null, 2), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
                    });
                    return addCorsHeaders(response);
                }
            }
        }
        return addCorsHeaders(Response.json({ error: "API不存在" }, { status: 404 }));
    }
}