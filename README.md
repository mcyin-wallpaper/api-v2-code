# 壁纸 API

基于 Cloudflare Workers 和 Supabase 构建的 Bing 每日壁纸服务：定时抓取 Bing 每日一图入库，提供搜索、详情、浏览量统计接口，并附带一个不落库的实时图片聚合接口。

## 功能特性

- 从 Bing 每日图片接口聚合两个时间窗口（`idx=0` 与 `idx=7`）的数据，自动去重并按日期降序排列
- 使用 Supabase 存储壁纸信息，按 `enddate` 增量入库，已存在的记录自动跳过
- 提供搜索、详情、浏览量自增、手动更新等接口，均支持 GET / POST
- 提供 `/bing-hp` 实时聚合接口，支持通过 `mkt` 切换市场区域（如 `zh-CN`、`en-US`），直接返回带 UHD 高清地址的图片列表
- 支持 Cron 定时触发自动更新
- 全接口开放跨域（CORS），并内置静态资源托管与 404 页面

## 项目结构

```
api-v2-code/
├── scripts/
│   ├── worker.js      # Worker 入口：路由、Bing 聚合、Supabase 读写、定时任务
│   └── workers.sh     # 根据环境变量生成 wrangler.jsonc
├── .gitignore
├── LICENSE
└── README.md
```

> 部署时还需要一个静态资源目录 `./public`（对应 `wrangler.jsonc` 中的 `assets.directory`），目录不存在时请先创建。

## 环境变量

`scripts/workers.sh` 会读取当前 Shell 中的以下环境变量，并写入生成的 `wrangler.jsonc` 的 `vars` 字段：

| 变量名 | 说明 |
| --- | --- |
| `SUPABASE_URL` | Supabase 项目 URL，例如 `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase 匿名密钥（anon key） |
| `SUPABASE_TABLE_NAME` | 存储壁纸数据的表名，例如 `bing_wallpaper_data` |

## 快速开始

1. 安装依赖：

   ```bash
   npm install @supabase/supabase-js
   ```

2. 导出环境变量后执行脚本，生成 `wrangler.jsonc`：

   ```bash
   export SUPABASE_URL="https://xxxx.supabase.co"
   export SUPABASE_ANON_KEY="你的-anon-key"
   export SUPABASE_TABLE_NAME="bing_wallpaper_data"
   bash scripts/workers.sh
   ```

3. 部署到 Cloudflare Workers：

   ```bash
   wrangler deploy
   ```

## API 接口

所有接口同时提供 `/api/*` 与 `/wallpaper/*` 两套等价路径；GET 参数走 Query String，POST 参数走 JSON Body。未知路径返回 `404` 与 `{ "error": "API不存在" }`。

### 接口总览

| 功能 | 路径（两套等价） | 方法 |
| --- | --- | --- |
| 搜索壁纸 | `/api/search`、`/wallpaper/search` | GET / POST |
| 壁纸详情 | `/api/detail`、`/wallpaper/detail` | GET / POST |
| 更新浏览量 | `/api/view`、`/wallpaper/view` | GET / POST |
| 手动更新数据 | `/api/update`、`/wallpaper/update` | GET / POST |
| 实时聚合图片 | `/api/bing-hp`、`/wallpaper/bing-hp` | GET / POST |

### 1. 搜索壁纸

分页搜索标题、版权信息或日期，结果按 `enddate` 降序返回。

- **参数**：

  | 参数 | 类型 | 默认 | 说明 |
  | --- | --- | --- | --- |
  | `search` | string | `""` | 关键词，模糊匹配 `title`、`copyright`、`enddate`；为空时返回全部 |
  | `page` | number | `1` | 页码，最小为 1 |
  | `limit` | number | `30` | 每页数量，范围 1–100 |

- **示例**：

  ```bash
  curl "https://你的域名/api/search?search=山&page=1&limit=10"
  ```

- **响应**：

  ```json
  {
    "Previous_Page": 1,
    "Page": 1,
    "Next_Page": 1,
    "output": [
      {
        "enddate": "20261017",
        "url": "https://cn.bing.com/th?id=OHR.xxx_UHD.jpg",
        "copyright": "……",
        "title": "……",
        "views": 0
      }
    ]
  }
  ```

  当返回条数不足一页时 `Next_Page` 等于当前页，表示没有下一页。

### 2. 获取壁纸详情

按 `enddate` 精确查询单条记录。

- **参数**：`enddate`（必填），8 位日期字符串，如 `20261017`
- **示例**：

  ```bash
  curl "https://你的域名/api/detail?enddate=20261017"
  ```

- **响应**：结构同搜索接口，`output` 为最多 1 条的数组；查询失败返回 `400`。

### 3. 更新浏览量

通过数据库函数 `increment_wallpaper_views` 将指定壁纸的 `views` 原子自增 1（单条 `UPDATE ... SET views = views + 1`，无并发竞态），并返回更新后的值。使用前需先在 Supabase 中创建该函数，见[数据库表结构](#数据库表结构)。

- **参数**：`enddate`（必填）
- **示例**：

  ```bash
  curl -X POST "https://你的域名/api/view" \
    -H "Content-Type: application/json" \
    -d '{"enddate":"20261017"}'
  ```

- **响应**：

  ```json
  { "output": [{ "views": 1 }] }
  ```

  `enddate` 不存在时返回 `404`：`{ "error": "No data found for the given enddate" }`。

### 4. 手动更新壁纸数据

实时从 Bing 拉取最新壁纸并增量写入 Supabase，无需等待定时任务。

- **参数**：无
- **响应**：

  ```json
  {
    "inserted": 2,
    "skipped": 13,
    "errors": []
  }
  ```

  - `inserted`：新插入条数
  - `skipped`：因 `enddate` 已存在而跳过的条数
  - `errors`：查重或插入过程中的错误信息数组；抓取异常时返回 `500`

### 5. 实时聚合 Bing 图片（不落库）

直接聚合 Bing 两个时间窗口的图片返回，不读写数据库，适合前端直接展示最新图库。

- **参数**：

  | 参数 | 类型 | 默认 | 说明 |
  | --- | --- | --- | --- |
  | `mkt` | string | `zh-CN` | 市场区域；`zh-CN` 时图片域名为 `cn.bing.com`，其他区域为 `www.bing.com` |

- **示例**：

  ```bash
  curl "https://你的域名/api/bing-hp?mkt=en-US"
  ```

- **响应**：

  ```json
  {
    "images": [
      {
        "enddate": "20261017",
        "urlbase": "/th?id=OHR.xxx",
        "copyright": "……",
        "title": "……",
        "uhdurl": "https://cn.bing.com/th?id=OHR.xxx_UHD.jpg",
        "whurl": "https://cn.bing.com/th?id=OHR.xxx_UHD.jpg&w=3840&h=2160&rs=1&c=1"
      }
    ],
    "totalImages": 15,
    "mkt": "zh-CN",
    "sourceUrls": [
      "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN",
      "https://www.bing.com/HPImageArchive.aspx?format=js&idx=7&n=8&mkt=zh-CN"
    ],
    "timestamp": 1789000000000
  }
  ```

  每张图片在 Bing 原始字段基础上额外补充：
  - `uhdurl`：UHD 高清图地址
  - `whurl`：4K（3840×2160）分辨率地址

## 定时任务

Worker 导出了 `scheduled` 处理器，触发时会执行与 `/api/update` 相同的增量更新逻辑。`scripts/workers.sh` 生成的配置默认不含 Cron 触发器，需要在 `wrangler.jsonc` 中补充，例如每天 UTC 00:07 执行一次：

```jsonc
{
  // ...其余配置
  "triggers": {
    "crons": ["7 0 * * *"]
  }
}
```

## 静态资源与路由优先级

生成的 `wrangler.jsonc` 开启了静态资源托管（`./public`）与 404 页面，并通过 `run_worker_first` 精确声明了 10 个 API 路径，只有这些路径会优先进入 Worker，其余路径全部由静态资源响应：

```
/api/search  /api/detail  /api/view  /api/update  /api/bing-hp
/wallpaper/search  /wallpaper/detail  /wallpaper/view  /wallpaper/update  /wallpaper/bing-hp
```

精确匹配不包含查询字符串，因此带参数的请求（如 `/api/search?page=2`）仍会正常进入 Worker。

## 数据库表结构

Supabase 表至少包含以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enddate` | text | 8 位日期，主键，非空 |
| `url` | text | UHD 壁纸地址，可为空 |
| `copyright` | text | 版权信息，可为空 |
| `title` | text | 标题，可为空 |
| `views` | bigint | 浏览量，可为空；Worker 写入新记录时默认填 0 |

建表 SQL 示例：

```sql
create table public.bing_wallpaper_data (
  copyright text null,
  enddate text not null,
  title text null,
  url text null,
  views bigint null,
  constraint bing_wallpaper_data_pkey primary key (enddate)
) TABLESPACE pg_default;
```

浏览量原子自增函数（`/api/view` 依赖；函数以调用者权限执行，因此表上仍需配置允许 `anon` 角色 UPDATE 的 RLS 策略）：

```sql
create or replace function public.increment_wallpaper_views(p_enddate text)
returns table(views bigint)
language plpgsql
set search_path = ''
as $$
begin
  return query
  with upd as (
    update public.bing_wallpaper_data
       set views = coalesce(bing_wallpaper_data.views, 0) + 1
     where enddate = p_enddate
    returning bing_wallpaper_data.views
  )
  select upd.views from upd;
end;
$$;
```

## CORS 与错误处理

- 所有响应（含错误响应）均附带：`Access-Control-Allow-Origin: *`，允许方法 `GET, POST, OPTIONS`，预检缓存 86400 秒
- `OPTIONS` 预检请求直接返回 `204`
- 参数或数据库错误返回 `400`，记录不存在返回 `404`，上游 Bing 接口异常返回 `500`

## 技术栈

- Cloudflare Workers（Fetch 处理器 + Scheduled Cron 处理器 + Static Assets）
- Supabase（PostgreSQL）
- @supabase/supabase-js

## 开源协议

MIT License
