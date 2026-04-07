-- Social Super Server — PostgreSQL Views voor Rapportage
-- Uitvoeren via: psql -U directus -d directus -f create-sql-views-postgres.sql

-- 1. Post Performance — Posts met engagement metrics en scores
DROP VIEW IF EXISTS v_post_performance;
CREATE VIEW v_post_performance AS
SELECT
  p.id,
  p.title,
  p.post_type,
  p.approval_status,
  b.title AS bedrijf_naam,
  p.bedrijf,
  p.published_at,
  p.engagement_likes,
  p.engagement_comments,
  p.engagement_shares,
  p.engagement_saves,
  p.engagement_clicks,
  p.engagement_reach,
  p.engagement_impressions,
  p.engagement_score,
  p.seo_score,
  p.seo_focus_keyword,
  p.blog_views,
  p.blog_comments,
  p.ai_generated,
  p.ai_confidence_score,
  CASE
    WHEN p.engagement_reach > 0
    THEN ROUND((p.engagement_likes + p.engagement_comments + p.engagement_shares)::numeric / p.engagement_reach * 100, 2)
    ELSE 0
  END AS engagement_rate
FROM "Posts" p
LEFT JOIN "Bedrijven" b ON p.bedrijf = b.id
WHERE p.published_at IS NOT NULL;

-- 2. Lead Funnel — Leads per fase per bedrijf
DROP VIEW IF EXISTS v_lead_funnel;
CREATE VIEW v_lead_funnel AS
SELECT
  b.title AS bedrijf_naam,
  l.bedrijf,
  l.lead_temperature,
  l.status,
  COUNT(*) AS aantal,
  ROUND(AVG(l.lead_score)::numeric, 1) AS avg_score,
  SUM(CASE WHEN l.converted_at IS NOT NULL THEN 1 ELSE 0 END) AS converted,
  SUM(COALESCE(l.conversion_value, 0)) AS total_conversion_value
FROM "Leads" l
LEFT JOIN "Bedrijven" b ON l.bedrijf = b.id
GROUP BY b.title, l.bedrijf, l.lead_temperature, l.status;

-- 3. Content per Bedrijf — Overzicht van content output
DROP VIEW IF EXISTS v_content_per_bedrijf;
CREATE VIEW v_content_per_bedrijf AS
SELECT
  b.title AS bedrijf_naam,
  p.bedrijf,
  COUNT(*) AS totaal_posts,
  SUM(CASE WHEN p.approval_status = 'published' THEN 1 ELSE 0 END) AS gepubliceerd,
  SUM(CASE WHEN p.approval_status = 'pending_review' THEN 1 ELSE 0 END) AS wacht_op_review,
  SUM(CASE WHEN p.post_type = 'blog' THEN 1 ELSE 0 END) AS blogs,
  SUM(CASE WHEN p.ai_generated THEN 1 ELSE 0 END) AS ai_gegenereerd,
  ROUND(AVG(CASE WHEN p.seo_score > 0 THEN p.seo_score END)::numeric, 1) AS avg_seo_score,
  SUM(p.blog_views) AS totaal_blog_views,
  SUM(p.engagement_likes) AS totaal_likes,
  SUM(p.engagement_comments) AS totaal_comments,
  SUM(p.engagement_shares) AS totaal_shares,
  SUM(p.engagement_reach) AS totaal_reach
FROM "Posts" p
LEFT JOIN "Bedrijven" b ON p.bedrijf = b.id
GROUP BY b.title, p.bedrijf;

-- 4. Best Content — Top posts op basis van engagement
DROP VIEW IF EXISTS v_best_content;
CREATE VIEW v_best_content AS
SELECT
  p.id,
  p.title,
  p.post_type,
  b.title AS bedrijf_naam,
  p.published_at,
  p.engagement_likes,
  p.engagement_comments,
  p.engagement_shares,
  p.engagement_reach,
  p.engagement_score,
  p.platform_post_url,
  CASE
    WHEN p.engagement_reach > 0
    THEN ROUND((p.engagement_likes + p.engagement_comments + p.engagement_shares)::numeric / p.engagement_reach * 100, 2)
    ELSE 0
  END AS engagement_rate
FROM "Posts" p
LEFT JOIN "Bedrijven" b ON p.bedrijf = b.id
WHERE p.published_at IS NOT NULL
ORDER BY p.engagement_score DESC NULLS LAST, p.engagement_reach DESC
LIMIT 50;

-- 5. Lead Bronnen — Welk platform/bron levert de meeste leads
DROP VIEW IF EXISTS v_lead_bronnen;
CREATE VIEW v_lead_bronnen AS
SELECT
  b.title AS bedrijf_naam,
  l.bedrijf,
  l.bron,
  COUNT(*) AS aantal_leads,
  ROUND(AVG(l.lead_score)::numeric, 1) AS avg_score,
  SUM(CASE WHEN l.lead_temperature = 'hot' THEN 1 ELSE 0 END) AS hot_leads,
  SUM(CASE WHEN l.lead_temperature = 'warm' THEN 1 ELSE 0 END) AS warm_leads,
  SUM(CASE WHEN l.lead_temperature = 'cold' THEN 1 ELSE 0 END) AS cold_leads
FROM "Leads" l
LEFT JOIN "Bedrijven" b ON l.bedrijf = b.id
GROUP BY b.title, l.bedrijf, l.bron
ORDER BY aantal_leads DESC;

-- 6. SEO Overview — Blog SEO performance per bedrijf
DROP VIEW IF EXISTS v_seo_overview;
CREATE VIEW v_seo_overview AS
SELECT
  b.title AS bedrijf_naam,
  p.bedrijf,
  COUNT(*) AS totaal_blogs,
  SUM(CASE WHEN p.seo_score >= 80 THEN 1 ELSE 0 END) AS seo_good,
  SUM(CASE WHEN p.seo_score >= 50 AND p.seo_score < 80 THEN 1 ELSE 0 END) AS seo_ok,
  SUM(CASE WHEN p.seo_score > 0 AND p.seo_score < 50 THEN 1 ELSE 0 END) AS seo_poor,
  SUM(CASE WHEN p.seo_score = 0 THEN 1 ELSE 0 END) AS seo_none,
  ROUND(AVG(CASE WHEN p.seo_score > 0 THEN p.seo_score END)::numeric, 1) AS avg_score,
  SUM(p.blog_views) AS totaal_views,
  SUM(p.blog_comments) AS totaal_comments
FROM "Posts" p
LEFT JOIN "Bedrijven" b ON p.bedrijf = b.id
WHERE p.post_type = 'blog' AND p.wp_post_id IS NOT NULL
GROUP BY b.title, p.bedrijf;

-- 7. Publicatie Snelheid — Tijd tussen aanmaken en publiceren
DROP VIEW IF EXISTS v_publicatie_snelheid;
CREATE VIEW v_publicatie_snelheid AS
SELECT
  b.title AS bedrijf_naam,
  p.bedrijf,
  p.post_type,
  COUNT(*) AS aantal,
  ROUND(AVG(EXTRACT(EPOCH FROM (p.published_at::timestamp - p.date_created::timestamp)) / 3600)::numeric, 1) AS avg_uren_tot_publicatie,
  MIN(EXTRACT(EPOCH FROM (p.published_at::timestamp - p.date_created::timestamp)) / 3600)::numeric AS min_uren,
  MAX(EXTRACT(EPOCH FROM (p.published_at::timestamp - p.date_created::timestamp)) / 3600)::numeric AS max_uren
FROM "Posts" p
LEFT JOIN "Bedrijven" b ON p.bedrijf = b.id
WHERE p.published_at IS NOT NULL AND p.date_created IS NOT NULL
GROUP BY b.title, p.bedrijf, p.post_type;
