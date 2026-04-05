/**
 * Seed script: adds blog-related fields to Directus collections
 * and creates a WordPress Social Account entry template.
 *
 * Usage:  npx tsx scripts/seed-blog-fields.ts
 *
 * Reads DIRECTUS_URL and DIRECTUS_TOKEN from .env
 *
 * This script adds:
 * 1. Blog fields to the Posts collection (wp_post_id, wp_post_url, wp_site_url, blog_views, blog_comments)
 * 2. A template WordPress Social Account (platform: 'wordpress')
 */

import dotenv from 'dotenv';
dotenv.config();

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error('Missing DIRECTUS_URL or DIRECTUS_TOKEN in .env');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${DIRECTUS_TOKEN}`,
};

// Blog fields to add to Posts collection
const blogFields = [
  {
    field: 'wp_post_id',
    type: 'integer',
    meta: {
      interface: 'input',
      note: 'WordPress post ID after publishing',
      hidden: false,
      width: 'half',
      group: null,
    },
    schema: {
      is_nullable: true,
    },
  },
  {
    field: 'wp_post_url',
    type: 'string',
    meta: {
      interface: 'input',
      note: 'URL of published WordPress blog post',
      hidden: false,
      width: 'half',
      group: null,
    },
    schema: {
      is_nullable: true,
      max_length: 500,
    },
  },
  {
    field: 'wp_site_url',
    type: 'string',
    meta: {
      interface: 'input',
      note: 'WordPress site URL',
      hidden: true,
      width: 'half',
      group: null,
    },
    schema: {
      is_nullable: true,
      max_length: 500,
    },
  },
  {
    field: 'blog_views',
    type: 'integer',
    meta: {
      interface: 'input',
      note: 'Total page views from WordPress',
      hidden: false,
      width: 'half',
      readonly: true,
      group: null,
    },
    schema: {
      is_nullable: true,
      default_value: 0,
    },
  },
  {
    field: 'blog_comments',
    type: 'integer',
    meta: {
      interface: 'input',
      note: 'Total comments from WordPress',
      hidden: false,
      width: 'half',
      readonly: true,
      group: null,
    },
    schema: {
      is_nullable: true,
      default_value: 0,
    },
  },
];

async function addFieldIfNotExists(collection: string, fieldDef: Record<string, unknown>) {
  const fieldName = fieldDef.field as string;

  // Check if field already exists
  const checkRes = await fetch(`${DIRECTUS_URL}/fields/${collection}/${fieldName}`, { headers });
  if (checkRes.ok) {
    console.log(`  Field ${collection}.${fieldName} already exists, skipping`);
    return;
  }

  // Create field
  const res = await fetch(`${DIRECTUS_URL}/fields/${collection}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(fieldDef),
  });

  if (res.ok) {
    console.log(`  Created field ${collection}.${fieldName}`);
  } else {
    const error = await res.text();
    console.error(`  Failed to create ${collection}.${fieldName}: ${res.status} ${error}`);
  }
}

async function main() {
  console.log(`Directus: ${DIRECTUS_URL}\n`);

  // 1. Add blog fields to Posts collection
  console.log('Adding blog fields to Posts collection...');
  for (const field of blogFields) {
    await addFieldIfNotExists('Posts', field);
  }

  // 2. Add notification_email to Bedrijven if not exists
  console.log('\nAdding notification_email to Bedrijven...');
  await addFieldIfNotExists('Bedrijven', {
    field: 'notification_email',
    type: 'string',
    meta: {
      interface: 'input',
      note: 'Email address for notifications (review, leads, reports)',
      hidden: false,
      width: 'half',
    },
    schema: {
      is_nullable: true,
      max_length: 254,
    },
  });

  console.log('\n--- MANUAL STEPS ---');
  console.log('');
  console.log('1. Create a WordPress Social Account in Directus for each bedrijf:');
  console.log('   - platform: "wordpress"');
  console.log('   - url: "https://ijsuitdepolder.nl" (of andere site)');
  console.log('   - platform_user_id: WordPress username');
  console.log('   - access_token: WordPress Application Password');
  console.log('   - is_connected: true');
  console.log('   - posting_enabled: true');
  console.log('');
  console.log('2. Generate a WordPress Application Password:');
  console.log('   WordPress Admin → Users → Edit Profile → Application Passwords');
  console.log('   Enter a name (e.g. "Social Engine") and click "Add New"');
  console.log('   Copy the generated password (shown only once)');
  console.log('');
  console.log('Done!');
}

main().catch(console.error);
