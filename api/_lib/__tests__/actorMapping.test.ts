import { describe, it, expect } from 'vitest';
import { resolveActorPublicUserId } from '../actorMapping';

const USERS = [
  { id: 'pub-rayyan', auth_uid: 'auth-rayyan' },
  { id: 'pub-salih', auth_uid: 'auth-salih' },
  { id: 'pub-no-auth', auth_uid: null }, // a public user with no auth link
];

describe('resolveActorPublicUserId (auth.uid -> public.users.id)', () => {
  it('maps a known auth.uid to its public.users.id', () => {
    expect(resolveActorPublicUserId('auth-rayyan', USERS)).toBe('pub-rayyan');
    expect(resolveActorPublicUserId('auth-salih', USERS)).toBe('pub-salih');
  });

  it('returns null for a null/undefined actor (service / cron / webhook)', () => {
    expect(resolveActorPublicUserId(null, USERS)).toBeNull();
    expect(resolveActorPublicUserId(undefined, USERS)).toBeNull();
  });

  it('returns null for an auth.uid with no matching public.users row (caller logs + proceeds)', () => {
    expect(resolveActorPublicUserId('auth-unknown', USERS)).toBeNull();
  });

  it('does NOT match a null auth_uid against a null actor (null actor short-circuits first)', () => {
    // Even though a user has auth_uid=null, a null actor must resolve to null,
    // never accidentally adopt the auth_uid=null user's id.
    expect(resolveActorPublicUserId(null, USERS)).not.toBe('pub-no-auth');
  });
});
