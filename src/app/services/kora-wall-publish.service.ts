import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface WallConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  uploadEndpoint: string;
}
export interface WallPublishResult { status: 'pending_approval'; }

/**
 * Supabase Auth is used only to obtain the staff/operator access token.
 * The browser NEVER writes to Storage or the videos table.
 */
@Injectable({ providedIn: 'root' })
export class KoraWallPublishService {
  private client?: SupabaseClient;
  private config?: WallConfig;

  private async setup(): Promise<{ client: SupabaseClient; config: WallConfig }> {
    if (this.client && this.config) return { client: this.client, config: this.config };
    const response = await fetch(new URL('kora-wall-config.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw new Error('Event TV publishing is not configured.');
    const config = await response.json() as Partial<WallConfig>;
    if (!config.supabaseUrl || !config.supabasePublishableKey || !config.uploadEndpoint) {
      throw new Error('Event TV publishing is not configured. Ask the event operator to set up the protected upload endpoint.');
    }
    const target = new URL(config.uploadEndpoint);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) {
      throw new Error('Event TV upload requires an HTTPS endpoint.');
    }
    this.config = config as WallConfig;
    this.client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { autoRefreshToken: true, persistSession: false }
    });
    return { client: this.client, config: this.config };
  }

  async signInOperator(email: string, password: string): Promise<void> {
    if (!email || !password) throw new Error('Operator email and password are required.');
    const { client } = await this.setup();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Operator sign-in failed.');
  }

  async publish(mp4: Blob, eventSlug: string): Promise<WallPublishResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(eventSlug)) throw new Error('Enter the event slug provided by the operator.');
    if (mp4.type !== 'video/mp4') throw new Error('Only rendered MP4 videos can be published.');
    const { client, config } = await this.setup();
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('Operator sign-in is required before uploading.');
    const body = new FormData();
    body.set('video', new File([mp4], 'kora-ball.mp4', { type: 'video/mp4' }));
    body.set('eventSlug', eventSlug);
    const response = await fetch(config.uploadEndpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + data.session.access_token },
      body
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Your operator account is not authorized to publish videos.');
      if (response.status === 413) throw new Error('The MP4 exceeds the event upload size limit.');
      if (response.status === 429) throw new Error('Upload limit reached. Please try again later.');
      throw new Error('Event TV upload failed (' + response.status + '). The video was not published.');
    }
    return { status: 'pending_approval' };
  }
}
