import type { Device } from '../types';
import { DevicesResponseSchema } from '../types';
import type { FitbitClient } from './client';

export async function listDevices(client: FitbitClient): Promise<Device[]> {
  return client.requestJson(DevicesResponseSchema, {
    path: '/1/user/-/devices.json',
  });
}
