import type { Profile } from '../types';
import { ProfileSchema } from '../types';
import type { FitbitClient } from './client';

export async function getProfile(client: FitbitClient): Promise<Profile> {
  return client.requestJson(ProfileSchema, {
    path: '/1/user/-/profile.json',
  });
}
