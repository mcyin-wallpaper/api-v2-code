cat > wrangler.jsonc <<- EOF
{
  "name": "wallpaper-api",
  "compatibility_date": "$(date +%Y-%m-%d)",
  "main": "scripts/worker.js",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "404-page",
    "run_worker_first": [
      "/api/search",
      "/api/detail",
      "/api/view",
      "/api/update",
      "/api/bing-hp",
      "/wallpaper/search",
      "/wallpaper/detail",
      "/wallpaper/view",
      "/wallpaper/update",
      "/wallpaper/bing-hp"
    ]
  },
  "vars": {
    "SUPABASE_URL": "$SUPABASE_URL",
    "SUPABASE_TABLE_NAME": "$SUPABASE_TABLE_NAME"
  },
  "secrets": {
    "required": ["SUPABASE_ANON_KEY"]
  },
  "observability": {
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1,
      "invocation_logs": true,
      "persist": true
    },
    "traces": {
      "enabled": false,
      "head_sampling_rate": 1,
      "persist": true
    }
  }
}
EOF
echo "$SUPABASE_ANON_KEY" | npx wrangler versions secret put SUPABASE_ANON_KEY