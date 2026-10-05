import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function hashViewerToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateViewerToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'POST required.' });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const appOrigin = Deno.env.get('APP_ORIGIN');
  if (!url || !anonKey || !serviceKey || !appOrigin) {
    return respond(500, { error: 'Server configuration is incomplete.' });
  }

  let payload: { action?: string; email?: string; newEmail?: string; role?: string; token?: string };
  try {
    payload = await request.json();
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (payload.action === 'read-link') {
    const requestOrigin = request.headers.get('Origin');
    if (requestOrigin && requestOrigin !== new URL(appOrigin).origin) return respond(403, { error: 'Viewer links are only accepted from the org chart website.' });
    const viewerToken = String(payload.token || '');
    if (viewerToken.length < 40 || viewerToken.length > 100) return respond(401, { error: 'This viewing link is invalid.' });
    const tokenHash = await hashViewerToken(viewerToken);
    const { data: activeLink, error: linkError } = await service.from('org_view_links').select('active,token_hash,generated_token_hash').eq('id', 1).maybeSingle();
    if (linkError || !activeLink?.active || (activeLink.token_hash !== tokenHash && activeLink.generated_token_hash !== tokenHash)) return respond(401, { error: 'This viewing link is invalid.' });
    const { data: stateRow, error: stateError } = await service.from('org_state').select('state').eq('id', 1).single();
    if (stateError) return respond(500, { error: 'The shared directory could not be loaded.' });
    return respond(200, { state: stateRow.state });
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return respond(401, { error: 'Sign in is required.' });
  const token = authorization.slice('Bearer '.length);
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return respond(401, { error: 'Your sign-in has expired.' });

  const { data: caller, error: callerError } = await service
    .from('org_members')
    .select('role')
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (callerError || caller?.role !== 'admin') return respond(403, { error: 'Only an administrator can manage sharing.' });

  if (payload.action === 'list') {
    const { data, error } = await service
      .from('org_members')
      .select('user_id,email,role,created_at')
      .order('created_at');
    return error ? respond(500, { error: 'Could not load shared access.' }) : respond(200, { members: data });
  }

  if (payload.action === 'create-view-link') {
    // Idempotent: an existing token is NEVER replaced, even by old clients.
    const readLink = () => service.from('org_view_links')
      .select('active,token_hash,token_value,generated_token_hash').eq('id', 1).maybeSingle();
    let { data: link, error } = await readLink();
    if (error) return respond(500, { error: 'Could not load the permanent viewer link. Apply generate-permanent-view-link.sql before deploying this function.' });
    if (!link) {
      const value = generateViewerToken();
      const { error: insertError } = await service.from('org_view_links').insert({
        id: 1,
        token_hash: await hashViewerToken(value),
        token_value: value,
        active: true,
        created_at: new Date().toISOString(),
        created_by: authData.user.id,
      });
      // Concurrent administrators may both see an empty table. The primary key
      // chooses one winner; the loser reads that SAME token instead of rotating.
      if (insertError && insertError.code !== '23505') return respond(500, { error: 'Could not create the permanent viewer link.' });
      ({ data: link, error } = await readLink());
      if (error || !link) return respond(500, { error: 'Could not load the permanent viewer link.' });
    }
    if (!link.token_value) {
      // Keep the legacy hash valid, even if nobody retained its original URL.
      // Save one copyable token once; concurrent requests read the same winner.
      const existingToken = String(payload.token || '');
      if (existingToken && (existingToken.length < 40 || existingToken.length > 100 || await hashViewerToken(existingToken) !== link.token_hash)) {
        return respond(400, { error: 'That is not the current viewer link.' });
      }
      const value = existingToken || generateViewerToken();
      const { error: saveError } = await service.from('org_view_links')
        .update({ token_value: value, generated_token_hash: existingToken ? null : await hashViewerToken(value), active: true })
        .eq('id', 1).is('token_value', null);
      if (saveError) return respond(500, { error: 'Could not save the permanent viewer link. Apply generate-permanent-view-link.sql first.' });
      ({ data: link, error } = await readLink());
      if (error || !link?.token_value) return respond(500, { error: 'Could not load the saved viewer link.' });
    }
    if (!link.active) {
      const { error: activateError } = await service.from('org_view_links').update({ active: true }).eq('id', 1);
      if (activateError) return respond(500, { error: 'Could not enable the permanent viewer link.' });
    }
    const shareUrl = new URL(appOrigin);
    shareUrl.hash = `view=${link.token_value}`;
    return respond(200, { url: shareUrl.toString() });
  }

  if (payload.action === 'revoke-view-link') {
    return respond(409, { error: 'The viewer link is permanent and cannot be revoked or replaced.' });
  }

  if (payload.action === 'view-link-status') {
    const { data, error } = await service.from('org_view_links').select('active,created_at').eq('id', 1).maybeSingle();
    return error ? respond(500, { error: 'Could not check viewer-link status.' }) : respond(200, { active: Boolean(data?.active), createdAt: data?.created_at || null });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond(400, { error: 'Enter a valid email address.' });
  if (payload.action === 'invite') {
    const role = payload.role === 'admin' ? 'admin' : 'viewer';
    if (role === 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error) return respond(500, { error: 'Could not verify administrator capacity.' });
      const { data: existing } = await service.from('org_members').select('role').eq('email', email).maybeSingle();
      if (existing?.role !== 'admin' && (count || 0) >= 10) return respond(409, { error: 'The ten administrator positions are already filled.' });
    }

    let invitedUser: { id: string; email?: string | null } | null = null;
    const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(email, {
      redirectTo: appOrigin,
    });
    if (inviteError) {
      const message = inviteError.message.toLowerCase();
      if (!message.includes('already') && !message.includes('exists') && !message.includes('registered')) {
        return respond(400, { error: inviteError.message });
      }
      for (let page = 1; page <= 10 && !invitedUser; page += 1) {
        const { data: users, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return respond(500, { error: 'Could not find the existing invited account.' });
        invitedUser = users.users.find((user) => user.email?.toLowerCase() === email) || null;
        if (users.users.length < 1000) break;
      }
    } else {
      invitedUser = invited.user;
    }
    if (!invitedUser) return respond(500, { error: 'The invitation was created without a user record.' });

    const { error: memberError } = await service.from('org_members').upsert({
      user_id: invitedUser.id,
      email,
      role,
      invited_by: authData.user.id,
    }, { onConflict: 'user_id' });
    if (memberError) {
      if (memberError.message.includes('maximum of ten')) return respond(409, { error: 'The ten administrator positions are already filled.' });
      return respond(500, { error: 'The invitation could not be assigned directory access.' });
    }
    return respond(200, { message: 'Access granted.', role, invitationSent: !inviteError });
  }

  if (payload.action === 'update-member') {
    const newEmail = String(payload.newEmail || '').trim().toLowerCase();
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return respond(400, { error: 'Enter a valid replacement email address.' });
    const { data: target, error: targetError } = await service.from('org_members').select('user_id,email,role').eq('email', email).maybeSingle();
    if (targetError || !target) return respond(404, { error: 'That person is not on the access list.' });
    const role = payload.role === 'admin' ? 'admin' : 'viewer';
    if (target.role !== 'admin' && role === 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error) return respond(500, { error: 'Could not verify administrator capacity.' });
      if ((count || 0) >= 10) return respond(409, { error: 'The ten administrator positions are already filled.' });
    }
    if (target.role === 'admin' && role !== 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error || (count || 0) <= 1) return respond(409, { error: 'At least one administrator must remain.' });
    }
    const { data: duplicate, error: duplicateError } = await service.from('org_members').select('user_id').eq('email', newEmail).maybeSingle();
    if (duplicateError) return respond(500, { error: 'Could not validate the replacement email.' });
    if (duplicate && duplicate.user_id !== target.user_id) return respond(409, { error: 'That email already has directory access.' });
    if (newEmail !== target.email.toLowerCase()) {
      const { error: authUpdateError } = await service.auth.admin.updateUserById(target.user_id, { email: newEmail, email_confirm: true });
      if (authUpdateError) return respond(400, { error: `Could not update the Supabase account email: ${authUpdateError.message}` });
    }
    const { error: memberUpdateError } = await service.from('org_members').update({ email: newEmail, role }).eq('user_id', target.user_id);
    if (memberUpdateError) {
      if (newEmail !== target.email.toLowerCase()) await service.auth.admin.updateUserById(target.user_id, { email: target.email, email_confirm: true });
      if (memberUpdateError.message.includes('maximum of ten')) return respond(409, { error: 'The ten administrator positions are already filled.' });
      return respond(500, { error: 'The account email changed but the access record did not. The previous email was restored where possible.' });
    }
    return respond(200, { message: 'Email and access role updated.' });
  }

  if (payload.action === 'set-role') {
    const role = payload.role === 'admin' ? 'admin' : 'viewer';
    const { data: target, error: targetError } = await service.from('org_members').select('user_id,role').eq('email', email).maybeSingle();
    if (targetError || !target) return respond(404, { error: 'That person is not on the sharing list.' });
    if (target.role === 'admin' && role !== 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error || (count || 0) <= 1) return respond(409, { error: 'At least one administrator must remain.' });
    }
    const { error } = await service.from('org_members').update({ role }).eq('user_id', target.user_id);
    if (error) return respond(error.message.includes('maximum of ten') ? 409 : 500, { error: error.message });
    return respond(200, { message: 'Access role updated.' });
  }

  if (payload.action === 'remove') {
    const { data: target, error: targetError } = await service.from('org_members').select('user_id,role').eq('email', email).maybeSingle();
    if (targetError || !target) return respond(404, { error: 'That person is not on the sharing list.' });
    if (target.user_id === authData.user.id) return respond(400, { error: 'You cannot remove your own access.' });
    if (target.role === 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error || (count || 0) <= 1) return respond(409, { error: 'At least one administrator must remain.' });
    }
    const { error } = await service.from('org_members').delete().eq('user_id', target.user_id);
    return error ? respond(500, { error: 'Could not remove access.' }) : respond(200, { message: 'Access removed.' });
  }

  return respond(400, { error: 'Unsupported sharing action.' });
});
