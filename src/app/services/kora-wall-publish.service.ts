import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface WallConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}
export interface WallPublishResult { status: 'pending_approval'; }

/**
 * Uploads generated MP4 bytes DIRECTLY to the private Supabase Storage bucket.
 * An authenticated operator and restrictive Storage RLS policy are required.
 * A privileged SQL RPC registers the object as unapproved; the client cannot
 * change consent/approval flags or write directly to the wall metadata table.
 */
@Injectable({ providedIn: 'root' })
export class KoraWallPublishService {
  private client?: SupabaseClient;

  private async setup(): Promise<SupabaseClient> {
    if (this.client) return this.client;
    const response = await fetch(new URL('kora-wall-config.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) throw new Error('Supabase publishing is not configured.');
    const config = await response.json() as Partial<WallConfig>;
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      throw new Error('Configure the Supabase project URL and publishable key before using event TV publishing.');
    }
    const url = new URL(config.supabaseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('Supabase requires an HTTPS URL.');
    }
    this.client = createClient(url.toString(), config.supabasePublishableKey, {
      auth: { autoRefreshToken: true, persistSession: false }
    });
    return this.client;
  }

  async signInOperator(email: string, password: string): Promise<void> {
    if (!email || !password) throw new Error('Operator email and password are required.');
    const client = await this.setup();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Operator sign-in failed.');
  }

  async publish(mp4: Blob, eventSlug: string): Promise<WallPublishResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(eventSlug)) {
      throw new Error('Enter an event slug using letters, numbers, underscores or hyphens.');
    }
    if (mp4.type !== 'video/mp4') throw new Error('Only rendered MP4 videos can be published.');
    if (mp4.size === 0 || mp4.size > 100 * 1024 * 1024) {
      throw new Error('The MP4 must be within the 100 MiB Storage limit.');
    }
    // Fast client-side sanity check; bucket RLS and later moderation/validation
    // are authoritative, never client-provided metadata.
    const header = new Uint8Array(await mp4.slice(0, 12).arrayBuffer());
    if (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') {
      throw new Error('The generated video does not appear to be a valid MP4.');
    }

    const client = await this.setup();
    const { data, error: userError } = await client.auth.getUser();
    if (userError || !data.user) throw new Error('Operator sign-in is required to upload videos.');

    // The random name is deliberately unpredictable, has no user-derived path
    // segments, and is validated independently by the Storage RLS policy.
    const path = 'balls/' + eventSlug + '/' + crypto.randomUUID() + '.mp4';
    const { error: uploadError } = await client.storage
      .from('kora-wall-media')
      .upload(path, mp4, { contentType: 'video/mp4', upsert: false, cacheControl: '3600' });
    if (uploadError) {
      throw new Error('Supabase Storage upload failed. Check operator permissions, bucket settings and file limits.');
    }

    // A security-definer RPC checks the actual Storage object exists and belongs
    // to this operator, then inserts consent=true and approved=false server-side.
    const { error: registerError } = await client.rpc('register_kora_wall_ball_video', {
      p_storage_path: path
    });
    if (registerError) {
      // No broad client DELETE policy: do not expose deletion of wall media.
      // A privileged cleanup job should remove any unregistered orphan objects.
      throw new Error('MP4 reached private Storage but registration failed. Contact the operator to clear the unregistered upload.');
    }
    return { status: 'pending_approval' };
  }
}
