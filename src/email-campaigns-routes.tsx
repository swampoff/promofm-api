/**
 * EMAIL CAMPAIGNS ROUTES — Система массовых рассылок (аналог SendPulse)
 * CRUD кампаний, сегментация, отправка через SMTP, статистика
 * Unsubscribe, pause/resume, open tracking pixel
 */

import { Hono } from 'hono';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';
// email_history — native cols since migration 079. Compound keys '<campaignId>_<kind>_<email>'
// decomposed на (campaign_id, kind, to_email) tuple — см. findCampaignEmailEvent.
import { findCampaignEmailEvent, upsertEmailHistory, publishEmailPrefsStore } from './db.tsx';
import { upsertEmailCampaign, getEmailCampaigns } from './db.tsx';
import { smtpSendEmail, smtpSendBatch } from './smtp-sender.tsx';
import { vpsListProfiles } from './vps-userdata.tsx';

const app = new Hono();

// ── KV store for unsubscribes ──
// Key: email address, Value: { unsubscribed_at, campaign_id? }
const UNSUB_PREFIX = 'unsub:';

// ── Store for campaigns (using jsonb KV) ──
// We use the existing email_campaigns table via db.tsx helpers

interface Campaign {
  id: string;
  name: string;
  subject: string;
  html: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'paused';
  segment: CampaignSegment;
  stats: CampaignStats;
  scheduled_at?: string;
  sent_at?: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

interface CampaignSegment {
  roles?: string[];           // artist, dj, venue, producer, radio_station
  registered_after?: string;  // ISO date
  registered_before?: string;
  has_tracks?: boolean;
  has_subscription?: boolean;
  email_verified?: boolean;
  custom_emails?: string[];   // manual list
}

interface CampaignStats {
  total_recipients: number;
  sent: number;
  failed: number;
  opened: number;
  errors: string[];
}

// ── Helpers ──

async function getCampaignById(id: string): Promise<Campaign | null> {
  const campaigns = await getEmailCampaigns('admin');
  return campaigns.find((c: any) => c.id === id) || null;
}

async function saveCampaign(campaign: Campaign): Promise<void> {
  await upsertEmailCampaign(campaign.id, { ...campaign, artist_id: 'admin' });
}

/**
 * Check if email is unsubscribed from campaigns
 */
async function isUnsubscribed(email: string): Promise<boolean> {
  try {
    const data = await publishEmailPrefsStore.get(`${UNSUB_PREFIX}${email.toLowerCase()}`);
    return !!data;
  } catch {
    return false;
  }
}

/**
 * Inject open tracking pixel into HTML
 * Adds a 1x1 transparent pixel that calls our tracking endpoint
 */
function injectTrackingPixel(html: string, campaignId: string, email: string): string {
  const baseUrl = process.env.PUBLIC_URL || 'https://promofm.org';
  const trackingUrl = `${baseUrl}/server/api/email-campaigns/track/open?c=${encodeURIComponent(campaignId)}&e=${encodeURIComponent(email)}`;
  const pixel = `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;

  // Insert before </body> if exists, otherwise append
  if (html.includes('</body>')) {
    return html.replace('</body>', `${pixel}</body>`);
  }
  return html + pixel;
}

/**
 * Rewrite links in HTML to go through click tracking redirect
 * Replaces <a href="URL"> with <a href="track/click?url=URL&c=campaign&e=email">
 */
function injectClickTracking(html: string, campaignId: string, email: string): string {
  const baseUrl = process.env.PUBLIC_URL || 'https://promofm.org';
  // Match href="..." in <a> tags, skip mailto: and # links
  return html.replace(
    /(<a\s[^>]*href=")([^"]+)(")/gi,
    (_match, before, url, after) => {
      // Skip mailto, tel, anchor, and tracking URLs
      if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('#') || url.includes('/track/')) {
        return `${before}${url}${after}`;
      }
      const trackUrl = `${baseUrl}/server/api/email-campaigns/track/click?url=${encodeURIComponent(url)}&c=${encodeURIComponent(campaignId)}&e=${encodeURIComponent(email)}`;
      return `${before}${trackUrl}${after}`;
    }
  );
}

/**
 * Build recipient list based on segment filters
 */
async function getRecipientsBySegment(segment: CampaignSegment): Promise<{ email: string; name: string; role: string }[]> {
  const recipients: { email: string; name: string; role: string }[] = [];

  // If custom emails specified, use them directly
  if (segment.custom_emails && segment.custom_emails.length > 0) {
    for (const email of segment.custom_emails) {
      recipients.push({ email, name: email.split('@')[0], role: 'custom' });
    }
    return recipients;
  }

  // Get users from local PostgreSQL (via vpsListProfiles)
  try {
    const allProfiles = await vpsListProfiles();

    for (const profile of allProfiles) {
      const email = (profile.email as string) || '';
      if (!email) continue;

      const role = (profile.role as string) || 'artist';
      const name = (profile.name as string) || email.split('@')[0];
      const createdAt = profile.createdAt as string;
      const isEmailVerified = profile.isEmailVerified as boolean;
      const tracksCount = (profile.tracksCount as number) || 0;

      // Apply filters
      if (segment.roles && segment.roles.length > 0) {
        if (!segment.roles.includes(role)) continue;
      }

      if (segment.registered_after && createdAt) {
        if (new Date(createdAt) < new Date(segment.registered_after)) continue;
      }

      if (segment.registered_before && createdAt) {
        if (new Date(createdAt) > new Date(segment.registered_before)) continue;
      }

      if (segment.email_verified === true) {
        if (!isEmailVerified) continue;
      }

      // has_tracks filter: check if user has uploaded tracks
      if (segment.has_tracks === true) {
        if (tracksCount <= 0) continue;
      }

      // has_subscription filter: check via profile data
      if (segment.has_subscription === true) {
        // Subscription status not tracked in basic profile — skip filter
        // TODO: add subscription_active to users table when subscriptions launch
      }

      recipients.push({ email, name, role });
    }
  } catch (err) {
    console.error('[Campaigns] Error fetching users:', err);
  }

  return recipients;
}

/**
 * Filter out unsubscribed emails from recipient list
 */
async function filterUnsubscribed(recipients: { email: string; name: string; role: string }[]): Promise<{ email: string; name: string; role: string }[]> {
  const filtered: typeof recipients = [];
  for (const r of recipients) {
    const unsub = await isUnsubscribed(r.email);
    if (!unsub) filtered.push(r);
  }
  return filtered;
}

// ============================================
// POST /unsubscribe — Unsubscribe from campaigns
// ============================================
app.post('/unsubscribe', async (c) => {
  try {
    const body = await c.req.json();
    const email = body.email?.trim().toLowerCase();
    const campaignId = body.campaign_id || null;

    if (!email || !email.includes('@')) {
      return c.json({ success: false, error: 'Valid email required' }, 400);
    }

    // Store unsubscribe
    await publishEmailPrefsStore.set(`${UNSUB_PREFIX}${email}`, {
      email,
      unsubscribed_at: new Date().toISOString(),
      campaign_id: campaignId,
    });

    console.log(`[Campaigns] Unsubscribed: ${email} (campaign: ${campaignId || 'all'})`);
    return c.json({ success: true, message: 'Successfully unsubscribed' });
  } catch (error) {
    console.error('[Campaigns] Unsubscribe error:', error);
    return c.json({ success: false, error: 'Failed to unsubscribe' }, 500);
  }
});

// ============================================
// GET /track/open — Open tracking pixel endpoint
// Returns 1x1 transparent GIF and increments open count
// ============================================
app.get('/track/open', async (c) => {
  const campaignId = c.req.query('c') || '';
  const email = c.req.query('e') || '';

  // Increment open count in background
  if (campaignId) {
    (async () => {
      try {
        const campaign = await getCampaignById(campaignId);
        if (campaign) {
          campaign.stats.opened = (campaign.stats.opened || 0) + 1;
          campaign.updated_at = new Date().toISOString();
          await saveCampaign(campaign);
        }

        // Also update email history
        if (email) {
          // Native (campaign_id, kind, to_email) dedup через partial index.
          const existing = await findCampaignEmailEvent(campaignId, 'open', email);
          if (!existing) {
            const now = new Date().toISOString();
            await upsertEmailHistory({
              id: `${campaignId}_open_${email}`, campaignId, kind: 'open',
              toEmail: email, opened: true, openedAt: now, sentAt: now,
            });
          }
        }
      } catch (err) {
        console.error('[Campaigns] Track open error:', err);
      }
    })();
  }

  // Return 1x1 transparent GIF
  const gif = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00,
    0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21,
    0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
    0x01, 0x00, 0x3b,
  ]);

  return new Response(gif, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
});

// ============================================
// GET /track/click — Click tracking redirect
// Logs click then redirects to original URL
// ============================================
app.get('/track/click', async (c) => {
  const url = c.req.query('url') || '';
  const campaignId = c.req.query('c') || '';
  const email = c.req.query('e') || '';

  // Log click in background
  if (campaignId && email) {
    (async () => {
      try {
        const now = new Date().toISOString();
        await upsertEmailHistory({
          id: `${campaignId}_click_${email}_${Date.now()}`,
          campaignId, kind: 'click', toEmail: email,
          type: 'click', clicked: true, clickedAt: now, sentAt: now,
          metadata: { url },
        });

        // Update campaign click count
        const campaign = await getCampaignById(campaignId);
        if (campaign) {
          const stats = campaign.stats as any;
          stats.clicked = (stats.clicked || 0) + 1;
          campaign.updated_at = new Date().toISOString();
          await saveCampaign(campaign);
        }
      } catch (err) {
        console.error('[Campaigns] Track click error:', err);
      }
    })();
  }

  // Redirect to original URL
  if (url) {
    return c.redirect(url, 302);
  }
  return c.redirect('https://promofm.org', 302);
});

// ============================================
// POST /campaigns/:id/resend-unopened — Resend to recipients who haven't opened
// ============================================
app.post('/campaigns/:id/resend-unopened', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    if (campaign.status !== 'sent') {
      return c.json({ success: false, error: 'Can only resend for completed campaigns' }, 400);
    }

    // Get all recipients
    let recipients = await getRecipientsBySegment(campaign.segment);
    recipients = await filterUnsubscribed(recipients);

    // Find who opened — check email history
    const openedEmails = new Set<string>();
    for (const r of recipients) {
      const opened = await findCampaignEmailEvent(campaign.id, 'open', r.email);
      if (opened) openedEmails.add(r.email);
    }

    // Filter to only unopened
    const unopened = recipients.filter(r => !openedEmails.has(r.email));

    if (unopened.length === 0) {
      return c.json({ success: true, data: { resent: 0 }, message: 'Все получатели уже открыли письмо' });
    }

    // Optional: different subject for resend
    const body = await c.req.json().catch(() => ({}));
    const resendSubject = body.subject || campaign.subject;

    // Send in background
    const resendInBackground = async () => {
      try {
        let sent = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const r of unopened) {
          let html = campaign.html;
          if (r.name) html = html.replace(/\{\{name\}\}/g, r.name);
          html = html.replace(/\{\{email\}\}/g, r.email);
          html = html.replace(/\{\{role\}\}/g, r.role);
          html = injectTrackingPixel(html, campaign.id, r.email);
          html = injectClickTracking(html, campaign.id, r.email);

          const result = await smtpSendEmail({
            to: r.email,
            subject: resendSubject,
            html,
            listUnsubscribe: true,
            campaignId: campaign.id,
          });

          if (result.success) sent++;
          else {
            failed++;
            errors.push(`${r.email}: ${result.error}`);
          }
        }

        // Update stats
        campaign.stats.sent += sent;
        campaign.stats.failed += failed;
        campaign.stats.errors = [...campaign.stats.errors, ...errors].slice(0, 50);
        campaign.updated_at = new Date().toISOString();
        await saveCampaign(campaign);

        console.log(`[Campaigns] Resend ${id}: ${sent} sent to unopened, ${failed} failed`);
      } catch (err) {
        console.error(`[Campaigns] Resend ${id} error:`, err);
      }
    };

    resendInBackground();

    return c.json({
      success: true,
      data: { unopened_count: unopened.length, total: recipients.length, opened: openedEmails.size },
      message: `Повторная отправка начата. ${unopened.length} неоткрывших из ${recipients.length}.`,
    });
  } catch (error) {
    console.error('[Campaigns] Resend error:', error);
    return c.json({ success: false, error: 'Failed to resend' }, 500);
  }
});

// ============================================
// GET /campaigns — List all campaigns
// ============================================
app.get('/campaigns', requireAuth, requireAdmin, async (c) => {
  try {
    const campaigns = await getEmailCampaigns('admin');
    // Sort by created_at desc
    campaigns.sort((a: any, b: any) =>
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );
    return c.json({ success: true, data: campaigns });
  } catch (error) {
    console.error('[Campaigns] List error:', error);
    return c.json({ success: true, data: [] });
  }
});

// ============================================
// GET /campaigns/:id — Get single campaign
// ============================================
app.get('/campaigns/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);
    return c.json({ success: true, data: campaign });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to load campaign' }, 500);
  }
});

// ============================================
// POST /campaigns — Create new campaign
// ============================================
app.post('/campaigns', requireAuth, requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { name, subject, html, segment, scheduled_at } = body;

    if (!name || !subject) {
      return c.json({ success: false, error: 'name and subject required' }, 400);
    }

    const id = `camp-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const campaign: Campaign = {
      id,
      name,
      subject,
      html: html || '',
      status: scheduled_at ? 'scheduled' : 'draft',
      segment: segment || {},
      stats: { total_recipients: 0, sent: 0, failed: 0, opened: 0, errors: [] },
      scheduled_at,
      created_at: now,
      updated_at: now,
      created_by: 'admin',
    };

    await saveCampaign(campaign);
    return c.json({ success: true, data: campaign });
  } catch (error) {
    console.error('[Campaigns] Create error:', error);
    return c.json({ success: false, error: 'Failed to create campaign' }, 500);
  }
});

// ============================================
// PUT /campaigns/:id — Update campaign
// ============================================
app.put('/campaigns/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const existing = await getCampaignById(id);
    if (!existing) return c.json({ success: false, error: 'Campaign not found' }, 404);

    if (existing.status === 'sending') {
      return c.json({ success: false, error: 'Cannot edit campaign while sending' }, 400);
    }

    const body = await c.req.json();
    const updated: Campaign = {
      ...existing,
      ...body,
      id, // prevent id change
      updated_at: new Date().toISOString(),
    };

    await saveCampaign(updated);
    return c.json({ success: true, data: updated });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to update campaign' }, 500);
  }
});

// ============================================
// DELETE /campaigns/:id — Delete campaign
// ============================================
app.delete('/campaigns/:id', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const existing = await getCampaignById(id);
    if (!existing) return c.json({ success: false, error: 'Campaign not found' }, 404);
    if (existing.status === 'sending') {
      return c.json({ success: false, error: 'Cannot delete while sending' }, 400);
    }

    // Mark as deleted by updating status
    existing.status = 'draft';
    existing.name = `[DELETED] ${existing.name}`;
    await saveCampaign(existing);

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to delete campaign' }, 500);
  }
});

// ============================================
// POST /campaigns/:id/pause — Pause sending campaign
// ============================================
app.post('/campaigns/:id/pause', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    if (campaign.status !== 'sending') {
      return c.json({ success: false, error: 'Can only pause a sending campaign' }, 400);
    }

    campaign.status = 'paused';
    campaign.updated_at = new Date().toISOString();
    await saveCampaign(campaign);

    console.log(`[Campaigns] Campaign ${id} paused`);
    return c.json({ success: true, data: campaign });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to pause campaign' }, 500);
  }
});

// ============================================
// POST /campaigns/:id/resume — Resume paused campaign
// ============================================
app.post('/campaigns/:id/resume', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    if (campaign.status !== 'paused') {
      return c.json({ success: false, error: 'Can only resume a paused campaign' }, 400);
    }

    // Get remaining recipients (those not yet sent to)
    let recipients = await getRecipientsBySegment(campaign.segment);
    recipients = await filterUnsubscribed(recipients);

    // Skip already-sent emails based on history
    const alreadySent = new Set<string>();
    for (const r of recipients) {
      const existing = await findCampaignEmailEvent(campaign.id, 'sent', r.email);
      if (existing) alreadySent.add(r.email);
    }
    const remaining = recipients.filter(r => !alreadySent.has(r.email));

    if (remaining.length === 0) {
      campaign.status = 'sent';
      campaign.updated_at = new Date().toISOString();
      await saveCampaign(campaign);
      return c.json({ success: true, data: campaign, message: 'All emails already sent' });
    }

    // Resume sending
    campaign.status = 'sending';
    campaign.updated_at = new Date().toISOString();
    await saveCampaign(campaign);

    // Send remaining in background
    const sendRemaining = async () => {
      try {
        const result = await smtpSendBatch(
          remaining.map(r => ({
            email: r.email,
            vars: { name: r.name, email: r.email, role: r.role },
          })),
          campaign.subject,
          campaign.html,
          { batchSize: 50, delayMs: 2000, campaignId: campaign.id }
        );

        campaign.stats.sent += result.sent;
        campaign.stats.failed += result.failed;
        campaign.stats.errors = [...campaign.stats.errors, ...result.errors].slice(0, 50);
        campaign.status = 'sent';
        campaign.sent_at = new Date().toISOString();
        campaign.updated_at = new Date().toISOString();
        await saveCampaign(campaign);

        console.log(`[Campaigns] Campaign ${id} resumed and completed: +${result.sent} sent, +${result.failed} failed`);
      } catch (err) {
        console.error(`[Campaigns] Campaign ${id} resume error:`, err);
        campaign.status = 'failed';
        campaign.updated_at = new Date().toISOString();
        await saveCampaign(campaign);
      }
    };

    sendRemaining();

    return c.json({
      success: true,
      data: { campaign_id: id, status: 'sending', remaining: remaining.length },
      message: `Возобновлена отправка. ${remaining.length} оставшихся получателей.`,
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to resume campaign' }, 500);
  }
});

// ============================================
// POST /campaigns/:id/preview — Get recipient count for segment
// ============================================
app.post('/campaigns/:id/preview', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    const recipients = await getRecipientsBySegment(campaign.segment);
    return c.json({
      success: true,
      data: {
        count: recipients.length,
        sample: recipients.slice(0, 10).map(r => ({ email: r.email, name: r.name, role: r.role })),
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to preview segment' }, 500);
  }
});

// ============================================
// POST /campaigns/:id/test — Send test email
// ============================================
app.post('/campaigns/:id/test', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    const body = await c.req.json();
    const testEmail = body.email;
    if (!testEmail) return c.json({ success: false, error: 'email required' }, 400);

    // Replace template vars with test values
    let html = campaign.html;
    html = html.replace(/\{\{name\}\}/g, 'Тестовый Пользователь');
    html = html.replace(/\{\{email\}\}/g, testEmail);
    html = html.replace(/\{\{role\}\}/g, 'artist');

    // Inject tracking pixel for test too
    html = injectTrackingPixel(html, campaign.id, testEmail);

    const result = await smtpSendEmail({
      to: testEmail,
      subject: `[ТЕСТ] ${campaign.subject}`,
      html,
    });

    return c.json({ success: result.success, error: result.error });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to send test email' }, 500);
  }
});

// ============================================
// POST /campaigns/:id/send — Start campaign sending
// ============================================
app.post('/campaigns/:id/send', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    if (campaign.status === 'sending') {
      return c.json({ success: false, error: 'Campaign already sending' }, 400);
    }
    if (!campaign.html || !campaign.subject) {
      return c.json({ success: false, error: 'Campaign needs subject and HTML body' }, 400);
    }

    // Get recipients and filter unsubscribed
    let recipients = await getRecipientsBySegment(campaign.segment);
    recipients = await filterUnsubscribed(recipients);

    if (recipients.length === 0) {
      return c.json({ success: false, error: 'No recipients match the segment (or all unsubscribed)' }, 400);
    }

    // Mark as sending
    campaign.status = 'sending';
    campaign.stats.total_recipients = recipients.length;
    campaign.updated_at = new Date().toISOString();
    await saveCampaign(campaign);

    // Send in background (non-blocking response)
    const sendInBackground = async () => {
      try {
        // Inject tracking pixel per recipient
        const recipientsWithTracking = recipients.map(r => {
          let html = campaign.html;
          // Replace template vars
          if (r.name) html = html.replace(/\{\{name\}\}/g, r.name);
          html = html.replace(/\{\{email\}\}/g, r.email);
          html = html.replace(/\{\{role\}\}/g, r.role);
          // Inject tracking
          html = injectClickTracking(html, campaign.id, r.email);
          html = injectTrackingPixel(html, campaign.id, r.email);
          return { email: r.email, vars: { name: r.name, email: r.email, role: r.role }, html };
        });

        // Use smtpSendBatch but with pre-processed HTML per email
        let sent = 0;
        let failed = 0;
        const errors: string[] = [];
        const batchSize = 50;
        const delayMs = 2000;

        for (let i = 0; i < recipientsWithTracking.length; i += batchSize) {
          // Check if campaign was paused
          const freshCampaign = await getCampaignById(id);
          if (freshCampaign?.status === 'paused') {
            console.log(`[Campaigns] Campaign ${id} paused at ${sent}/${recipientsWithTracking.length}`);
            return;
          }

          const batch = recipientsWithTracking.slice(i, i + batchSize);

          for (const r of batch) {
            const result = await smtpSendEmail({
              to: r.email,
              subject: campaign.subject,
              html: r.html,
              listUnsubscribe: true,
              campaignId: campaign.id,
            });

            if (result.success) {
              sent++;
              // Track sent email
              await upsertEmailHistory({
                id: `${campaign.id}_sent_${r.email}`,
                campaignId: campaign.id, kind: 'sent', toEmail: r.email,
                subject: campaign.subject, type: 'campaign', status: 'sent',
                sentAt: new Date().toISOString(), opened: false, clicked: false,
              });
            } else {
              failed++;
              errors.push(`${r.email}: ${result.error}`);
            }
          }

          // Delay between batches
          if (i + batchSize < recipientsWithTracking.length) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }

        campaign.stats.sent = sent;
        campaign.stats.failed = failed;
        campaign.stats.errors = errors.slice(0, 50);
        campaign.status = failed > 0 && sent === 0 ? 'failed' : 'sent';
        campaign.sent_at = new Date().toISOString();
        campaign.updated_at = new Date().toISOString();
        await saveCampaign(campaign);

        console.log(`[Campaigns] Campaign ${id} completed: ${sent} sent, ${failed} failed`);
      } catch (err) {
        console.error(`[Campaigns] Campaign ${id} send error:`, err);
        campaign.status = 'failed';
        campaign.stats.errors = [String(err)];
        campaign.updated_at = new Date().toISOString();
        await saveCampaign(campaign);
      }
    };

    // Fire and forget
    sendInBackground();

    return c.json({
      success: true,
      data: {
        campaign_id: id,
        status: 'sending',
        recipients_count: recipients.length,
        message: `Отправка начата. ${recipients.length} получателей.`,
      },
    });
  } catch (error) {
    console.error('[Campaigns] Send error:', error);
    return c.json({ success: false, error: 'Failed to start campaign' }, 500);
  }
});

// ============================================
// GET /campaigns/:id/stats — Campaign statistics
// ============================================
app.get('/campaigns/:id/stats', requireAuth, requireAdmin, async (c) => {
  const id = c.req.param('id');
  try {
    const campaign = await getCampaignById(id);
    if (!campaign) return c.json({ success: false, error: 'Campaign not found' }, 404);

    const stats = campaign.stats as any;
    return c.json({
      success: true,
      data: {
        ...campaign.stats,
        clicked: stats.clicked || 0,
        status: campaign.status,
        open_rate: campaign.stats.sent > 0
          ? ((campaign.stats.opened / campaign.stats.sent) * 100).toFixed(1) + '%'
          : '0%',
        click_rate: campaign.stats.sent > 0 && stats.clicked
          ? (((stats.clicked || 0) / campaign.stats.sent) * 100).toFixed(1) + '%'
          : '0%',
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to load stats' }, 500);
  }
});

// ============================================
// GET /segment/preview — Preview segment without campaign
// ============================================
app.post('/segment/preview', requireAuth, requireAdmin, async (c) => {
  try {
    const segment = await c.req.json() as CampaignSegment;
    const recipients = await getRecipientsBySegment(segment);
    return c.json({
      success: true,
      data: {
        count: recipients.length,
        sample: recipients.slice(0, 10).map(r => ({ email: r.email, name: r.name, role: r.role })),
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to preview segment' }, 500);
  }
});

// ============================================
// GET /stats — Overall campaign stats
// ============================================
app.get('/stats', requireAuth, requireAdmin, async (c) => {
  try {
    const campaigns = await getEmailCampaigns('admin');
    const total = campaigns.length;
    const sent = campaigns.filter((c: any) => c.status === 'sent').length;
    const drafts = campaigns.filter((c: any) => c.status === 'draft').length;
    const totalEmails = campaigns.reduce((sum: number, c: any) => sum + (c.stats?.sent || 0), 0);
    const totalFailed = campaigns.reduce((sum: number, c: any) => sum + (c.stats?.failed || 0), 0);
    const totalOpened = campaigns.reduce((sum: number, c: any) => sum + (c.stats?.opened || 0), 0);

    return c.json({
      success: true,
      data: {
        total_campaigns: total,
        sent_campaigns: sent,
        draft_campaigns: drafts,
        total_emails_sent: totalEmails,
        total_failed: totalFailed,
        total_opened: totalOpened,
        avg_open_rate: totalEmails > 0 ? ((totalOpened / totalEmails) * 100).toFixed(1) + '%' : '0%',
      },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to load stats' }, 500);
  }
});

export default app;
