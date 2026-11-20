import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface WallConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  eventSlug: string;
}
export interface WallPublishResult { status: 'pending_approval'; }

/**
 * Direct private Storage upload. Credentials are NEVER embedded in the PWA.
 * The operator signs in once on the event device; the session persists.
 * Supabase Storage RLS and the registration RPC enforce event permissions.
 */
@Injectable({ providedIn: 'root' })
export class KoraWallPublishService {
  private client?: SupabaseClient;
  private config?: WallConfig;

  private async setup(): Promise<{ client: SupabaseClient; config: WallConfig }> {
    if (this.client && this.config) return { client: this.client, config: this.config };
    const response = await fetch(new URL('kora-wall-config.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw new Error('Event TV upload configuration could not be loaded.');
    const config = await response.json() as Partial<WallConfig>;
    if (!config.supabaseUrl || !config.supabasePublishableKey ||
        !config.eventSlug || !/^[A-Za-z0-9_-]{1,64}$/.test(config.eventSlug)) {
      throw new Error('Set supabaseUrl, supabasePublishableKey and eventSlug in kora-wall-config.json.');
    }
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('The configured Supabase URL must use HTTPS.');
    }
    this.config = config as WallConfig;
    this.client = createClient(url.toString(), config.supabasePublishableKey, {
      // Once signed in on the authorized event device, operators do NOT
      // need to type credentials again for each generated ball.
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false }
    });
    return { client: this.client, config: this.config };
  }

  private async verifyOperator(): Promise<{ client: SupabaseClient; eventSlug: string }> {
    const { client, config } = await this.setup();
    // Always check the authenticated user, not the editable local state.
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      throw new Error('Operator setup required: sign in once on this event device.');
    }
    const claims = data.user.app_metadata;
    if (claims?.['kora_wall_operator'] !== true ||
        !Array.isArray(claims?.['kora_wall_events']) ||
        !claims['kora_wall_events'].includes(config.eventSlug)) {
      throw new Error('This Supabase operator is not authorized for the configured event.');
    }
    return { client, eventSlug: config.eventSlug };
  }

  async getOperatorStatus(): Promise<{ eventSlug: string; connected: boolean }> {
    const { config } = await this.setup();
    try {
      await this.verifyOperator();
      return { eventSlug: config.eventSlug, connected: true };
    } catch {
      return { eventSlug: config.eventSlug, connected: false };
    }
  }

  async signInOperator(email: string, password: string): Promise<void> {
    if (!email.trim() || !password) throw new Error('Operator email and password are required for first-time setup.');
    const { client } = await this.setup();
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new Error('Operator sign-in failed.');
    try {
      await this.verifyOperator();
    } catch (error) {
      await client.auth.signOut();
      throw error;
    }
  }

  async signOutOperator(): Promise<void> {
    const { client } = await this.setup();
    await client.auth.signOut();
  }

  async publish(mp4: Blob): Promise<WallPublishResult> {
    if (mp4.type !== 'video/mp4') throw new Error('Only generated MP4 videos may be uploaded.');
    if (mp4.size === 0 || mp4.size > 100 * 1024 * 1024) {
      throw new Error('The MP4 exceeds the 100 MiB bucket limit or is empty.');
    }
    const header = new Uint8Array(await mp4.slice(0, 12).arrayBuffer());
    if (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') {
      throw new Error('The generated file is not an MP4 container.');
    }
    const { client, eventSlug } = await this.verifyOperator();
    const path = 'balls/' + eventSlug + '/' + crypto.randomUUID() + '.mp4';
    const { error: uploadError } = await client.storage.from('kora-wall-media').upload(path, mp4, {
      contentType: 'video/mp4',
      upsert: false,
      cacheControl: '3600'
    });
    if (uploadError) {
      throw new Error('Storage upload failed: ' + uploadError.message);
    }

    // Protected SQL RPC sets event_screen_consent=true and approved=false.
    // The browser cannot approve or insert arbitrary video metadata rows.
    const { error: registrationError } = await client.rpc('register_kora_wall_ball_video', {
      p_storage_path: path
    });
    if (registrationError) {
      // The private bucket intentionally has no client DELETE policy.
      // A privileged cleanup job should delete this unregistered object.
      throw new Error('MP4 uploaded but metadata registration failed. An operator must clean the unregistered object.');
    }
    return { status: 'pending_approval' };
  }
}
