'use strict';

/**
 * Parse the JSON output of `system_profiler SPAudioDataType -json`
 * into a flat list of input devices.
 * Shape: [{ id: string, name: string }]
 */
function parseAudioDevices(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }

  // Flatten _items across all SPAudioDataType entries (usually one "coreaudio_device" group)
  const entries = data?.SPAudioDataType ?? [];
  const items = entries.flatMap((entry) => entry?._items ?? []);
  const devices = [];
  for (const item of items) {
    if (typeof item.coreaudio_device_input !== 'number' || item.coreaudio_device_input <= 0) continue;
    const id = String(item.coreaudio_device_id ?? item._name);
    const name = String(item._name ?? id);
    if (!id || !name) continue;
    devices.push({ id, name });
  }
  return devices;
}

module.exports = { parseAudioDevices };
