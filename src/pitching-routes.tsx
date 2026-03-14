
import { Hono } from 'hono';

const app = new Hono();

// Mock data for playlists
const PLAYLISTS = [
  { id: 'p1', name: 'New Music Friday', platform: 'Spotify', followers: 5000000 },
  { id: 'p2', name: 'Top Hits', platform: 'Apple Music', followers: 3000000 },
  { id: 'p3', name: 'Electronic Rising', platform: 'Spotify', followers: 800000 },
  { id: 'p4', name: 'Indie Radar', platform: 'Deezer', followers: 200000 },
];

// Mock data for radio stations
const RADIO_STATIONS = [
  { id: 'r1', name: 'Hit FM', region: 'Global', genre: 'Pop' },
  { id: 'r2', name: 'Rock Radio', region: 'USA', genre: 'Rock' },
  { id: 'r3', name: 'Jazz Cafe', region: 'France', genre: 'Jazz' },
  { id: 'r4', name: 'Electronic Waves', region: 'Germany', genre: 'Electronic' },
];

app.get('/playlists', (c) => {
  return c.json({ playlists: PLAYLISTS });
});

app.get('/radio-stations', (c) => {
  return c.json({ stations: RADIO_STATIONS });
});

app.post('/submit-pitch', async (c) => {
  const body = await c.req.json();
  console.log('Pitch submission:', body);
  return c.json({ 
    success: true, 
    message: 'Pitch submitted successfully',
    submissionId: `pitch_${Date.now()}`
  });
});

app.post('/submit-radio', async (c) => {
  const body = await c.req.json();
  console.log('Radio submission:', body);
  return c.json({ 
    success: true, 
    message: 'Radio submission successful',
    submissionId: `radio_${Date.now()}`
  });
});

export default app;
