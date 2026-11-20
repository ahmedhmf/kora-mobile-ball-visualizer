import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface WallConfig { supabaseUrl: string; supabasePublishableKey: string; }
interface UploadTicket { ticketId: string; ticketSecret: string; storagePath: string; uploadToken: string; posterPath: string; posterUploadToken: string; }

/** No user login. A server-issued single-object ticket authorizes direct Storage upload. */
@Injectable({ providedIn: 'root' })
export class KoraWallPublishService {
  private client?: SupabaseClient;
  private functionUrl?: string;

  private async setup(): Promise<{ client: SupabaseClient; functionUrl: string }> {
    if (this.client && this.functionUrl) return { client: this.client, functionUrl: this.functionUrl };
    const response = await fetch(new URL('kora-wall-config.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw new Error('Missing Supabase configuration.');
    const config = await response.json() as Partial<WallConfig>;
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      throw new Error('Configure the Supabase URL and public publishable key.');
    }
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('Supabase URL must use HTTPS.');
    }
    const base = url.toString().replace(/\/$/, '');
    this.client = createClient(base, config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    this.functionUrl = base + '/functions/v1/kora-wall-ticket';
    return { client: this.client, functionUrl: this.functionUrl };
  }

  private async callFunction(url: string, data: object): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(typeof result['error'] === 'string' ? result['error'] : 'Automatic upload failed (' + response.status + ').');
    }
    return result;
  }

  async publish(mp4: Blob, poster: Blob): Promise<void> {
    if (poster.type !== 'image/jpeg' || poster.size < 100 || poster.size > 2 * 1024 * 1024) {
      throw new Error('Ball still image must be JPEG and under 2 MiB.');
    }
    if (mp4.type !== 'video/mp4' || mp4.size < 12 || mp4.size > 20 * 1024 * 1024) {
      throw new Error('Generated MP4 must be under 20 MiB.');
    }
    const header = new Uint8Array(await mp4.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') throw new Error('Invalid MP4 container.');
    const { client, functionUrl } = await this.setup();
    const ticket = await this.callFunction(functionUrl, { action: 'ticket' }) as unknown as UploadTicket;
    if (!ticket.ticketId || !ticket.ticketSecret || !ticket.storagePath || !ticket.uploadToken || !ticket.posterPath || !ticket.posterUploadToken) {
      throw new Error('Incomplete video upload ticket.');
    }

    // MP4 bytes go straight to Supabase Storage, not through the function.
    const { error: uploadError } = await client.storage.from('kora-wall-media')
      .uploadToSignedUrl(ticket.storagePath, ticket.uploadToken, mp4, {
        contentType: 'video/mp4', cacheControl: '3600'
      });
    if (uploadError) throw new Error('Storage upload failed: ' + uploadError.message);

    const { error: posterError } = await client.storage.from('kora-wall-media')
      .uploadToSignedUrl(ticket.posterPath, ticket.posterUploadToken, poster, {
        contentType: 'image/jpeg', cacheControl: '3600'
      });
    if (posterError) throw new Error('Ball still-image upload failed: ' + posterError.message);

    const done = await this.callFunction(functionUrl, {
      action: 'complete', ticketId: ticket.ticketId, ticketSecret: ticket.ticketSecret
    });
    if (done['status'] !== 'published') throw new Error('The MP4 uploaded but could not be registered with the TV feed.');
  }
}
