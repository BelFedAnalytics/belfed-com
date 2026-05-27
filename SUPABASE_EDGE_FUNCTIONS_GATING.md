# Subscriber Gating — Required Supabase Changes

The client-side gating in this PR (login/expired screens, calling edge
functions with the user's Supabase JWT) is **not sufficient on its own**.
Anyone who knows the public anon key — which is embedded in the static
site — can hit the Supabase REST + Edge Function endpoints directly and
bypass the UI.

To enforce the "subscribers only" rule end-to-end, the following changes
must be deployed on the Supabase project (`obujqvqqmyfcfflhqvud`). The
Edge Function source is not in this repo, so deploy these out-of-band.

The canonical access policy (mirrors `belfed-auth.js::getEntitlement`):

```
access = TRUE  iff
  EXISTS subscription with status IN ('active','trialing')
        AND current_period_end > now()
  OR profiles.subscription_status = 'admin'
  OR profiles.subscription_status = 'active'
  OR (profiles.subscription_status = 'trial'
        AND profiles.trial_end > now())
```

A reusable SQL helper makes this easy to share across the edge functions
and RLS policies:

```sql
create or replace function public.user_has_access(uid uuid)
returns boolean
language sql stable security definer as $$
  select
    exists (
      select 1 from public.subscriptions s
      where s.user_id = uid
        and s.status in ('active','trialing')
        and s.current_period_end > now()
    )
    or exists (
      select 1 from public.profiles p
      where p.id = uid
        and (
          p.subscription_status in ('admin','active')
          or (p.subscription_status = 'trial' and p.trial_end > now())
        )
    );
$$;

create or replace function public.user_is_admin(uid uuid)
returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.subscription_status = 'admin'
  );
$$;

grant execute on function public.user_has_access(uuid) to anon, authenticated;
grant execute on function public.user_is_admin(uuid) to anon, authenticated;
```

---

## 1. Edge function: `analytics-get`

Called by `analytics-view.html`. Currently returns the full report for
any caller. Must now:

1. Read the caller's JWT from the `Authorization: Bearer <token>` header
   (NOT the anon-key bearer — distinguish them via `auth.getUser`).
2. If `teaser=1` query param is set OR the caller is anonymous (no
   user / invalid token), return **only** safe metadata. Specifically:
   - `report.title_ru`, `report.title_en`
   - `report.subtitle_ru`, `report.subtitle_en`
   - `report.report_date`
   - `report.report_type`
   - `report.tags`
   - `report.cover_image_url`
   - `report.slug`
   - **and NO `sections` array** (or an empty array)
3. If the caller is an authenticated subscriber (per `user_has_access`),
   return the full payload as today: `report` + `sections`.
4. If the caller is authenticated but `user_has_access` is FALSE,
   return HTTP 402/403 with `{ ok: false, error: 'subscription_required' }`.
   The client falls back to its expired screen.
5. Admins (`user_is_admin`) keep the ability to fetch unpublished
   drafts (status != 'published'). Anonymous + non-admin authed users
   should NEVER receive drafts.

Pseudocode (Deno/TS):

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const id   = url.searchParams.get("id");
  const teaserOnly = url.searchParams.get("teaser") === "1";
  if (!slug && !id) return json({ ok:false, error:"missing_slug_or_id" }, 400);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Identify caller (anon vs authed)
  let userId: string | null = null;
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token && token !== ANON_KEY) {
    const { data } = await admin.auth.getUser(token);
    userId = data?.user?.id ?? null;
  }

  // Look up entitlement (admin / access)
  let hasAccess = false, isAdmin = false;
  if (userId) {
    const access  = await admin.rpc("user_has_access", { uid: userId });
    const adminQ  = await admin.rpc("user_is_admin",   { uid: userId });
    hasAccess = !!access.data;
    isAdmin   = !!adminQ.data;
  }

  // Load report (drafts only for admins)
  const sel = "id,slug,status,report_date,report_type,tags,cover_image_url," +
              "title_ru,title_en,subtitle_ru,subtitle_en";
  let q = admin.from("analytics_reports").select(sel + ",author_id,created_at").limit(1);
  q = slug ? q.eq("slug", slug) : q.eq("id", id);
  if (!isAdmin) q = q.eq("status", "published");
  const { data: rRows, error: rErr } = await q;
  if (rErr) return json({ ok:false, error:"db_error" }, 500);
  const report = rRows?.[0];
  if (!report) return json({ ok:false, error:"not_found" }, 404);

  // Teaser path: anonymous OR ?teaser=1 OR authed-without-access.
  if (teaserOnly || !hasAccess) {
    return json({
      ok: true,
      report: {
        slug: report.slug,
        status: report.status,
        report_date: report.report_date,
        report_type: report.report_type,
        tags: report.tags,
        cover_image_url: report.cover_image_url,
        title_ru: report.title_ru,
        title_en: report.title_en,
        subtitle_ru: report.subtitle_ru,
        subtitle_en: report.subtitle_en,
      },
      // Sections deliberately omitted.
      sections: [],
      gated: !hasAccess && !teaserOnly,
    });
  }

  // Full payload — subscribers / admins only.
  const { data: sections } = await admin
    .from("analytics_report_sections")
    .select("*")
    .eq("report_id", report.id)
    .order("position", { ascending: true });

  return json({ ok:true, report, sections: sections || [] });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
```

> **Important:** keep the existing CORS handling and OPTIONS preflight
> branch from the current deployment — the snippet above shows only the
> entitlement-relevant changes.

---

## 2. Edge function: `analytics-list`

Called by `analytics.html` (the feed). Today it returns the full list of
report metadata to anonymous callers. New behavior:

1. Authenticate the caller the same way as `analytics-get`.
2. If the caller is anonymous OR not entitled, return HTTP 403 with
   `{ ok:false, error:'subscription_required', total: 0, items: [] }`.
   (The client already hides the feed UI for those users, so even if it
   ever fires the request, it gets nothing useful back.)
3. Admins still see all rows including drafts; non-admin subscribers see
   `status = 'published'` only.

If business decides later that **published titles** should be browsable
publicly (SEO / share previews), relax this to a teaser response —
omitting `body`, `sections`, `pdf_url`, etc.

---

## 3. Edge function: `analytics-admin-action`

Already requires a session JWT. Verify it explicitly checks
`user_is_admin(userId) = true` before any read/write. No client change
needed here. The admin draft preview path in `analytics-view.html`
continues to work because admins are authenticated callers and
`analytics-get` returns drafts for them.

---

## 4. Edge function: `analytics-preview`

Short-lived HMAC token used for cross-domain admin draft previews. The
client (`analytics-view.html`) already passes the token through. Verify
the function:

- Validates HMAC signature against the server secret.
- Enforces a short TTL (≤ 15 min).
- Returns drafts only when the token is valid; never falls back to
  unauthenticated reads.

No client change needed.

---

## 5. RLS on `analysis_posts` (Asset Analysis)

`asset-analysis.html` issues this query directly with the anon key:

```js
supaClient.from('analysis_posts')
  .select('id,ticker,company_name,asset_class,post_type,reply_name,reply_text,greeting_ru,greeting_en,body_ru,body_en,tradingview_url,hashtags,image_paths,published_at,created_at,message_id_ru,message_id_en,parent_post_id,slug')
  .eq('status','published')
```

Anyone holding the anon key can run the same query. Add RLS policies:

```sql
alter table public.analysis_posts enable row level security;

-- Subscribers (and admins) can read published posts.
drop policy if exists "analysis_posts_subscriber_read" on public.analysis_posts;
create policy "analysis_posts_subscriber_read"
on public.analysis_posts
for select
to authenticated
using (
  status = 'published'
  and public.user_has_access(auth.uid())
);

-- Admins additionally see drafts.
drop policy if exists "analysis_posts_admin_read" on public.analysis_posts;
create policy "analysis_posts_admin_read"
on public.analysis_posts
for select
to authenticated
using ( public.user_is_admin(auth.uid()) );

-- Anonymous role: NO read access. (Do not add an "anon" SELECT policy.)
-- Existing admin write policies stay as-is.
```

Verify the same policy is appropriate for any related tables
(`analysis_post_images`, etc.) referenced by joins.

If a public teaser feed is ever desired for SEO, expose it via a SECURITY
DEFINER function or a separate edge function that returns only safe
columns (ticker, title, date, post type) — not via direct RLS.

### Storage bucket for images

`analysis-images` storage bucket is currently public
(`SUPA_URL_PUB = '.../storage/v1/object/public/analysis-images/'`).
If image leakage matters, mark the bucket private and serve via signed
URLs from the (gated) edge function. Otherwise the images remain
fetchable by URL even after the table is gated.

---

## 6. Deployment checklist

1. Apply the SQL helpers from §0 (`user_has_access`, `user_is_admin`).
2. Apply RLS policies on `analysis_posts` from §5.
3. Deploy updated `analytics-get` (§1) and `analytics-list` (§2).
4. Smoke test, signed in as each role:
   - anonymous: feed = 403; detail = teaser only; admin draft URL via
     `preview_token` still works.
   - active subscriber: full feed + full detail.
   - trial (not expired): same as active.
   - expired / no subscription: feed = 403, detail = teaser only.
   - admin: drafts visible in both list and detail.
5. Verify `t.me/BelfedBot?start=auth` Telegram subscription flow still
   activates a subscription row (no change required there, just sanity).
