/**
 * ELEVENLABS TTS INTEGRATION
 * Генерация аудио контента через ElevenLabs API
 * 
 * Endpoints:
 * - POST /generate - Генерация аудио из текста
 * - GET /voices - Список доступных голосов
 */

import { Hono } from 'hono';
import { getDbClient } from './db-client.tsx';
import * as db from './db.tsx';
import { pool as elPool } from './db-client.tsx';
import { safeErrorMessage } from './security.tsx';

const ADMIN_INTERNAL_KEY = process.env.VPS_INTERNAL_KEY || '';

async function requireAdminOrKey(c: any, next: any) {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey && ADMIN_INTERNAL_KEY && internalKey === ADMIN_INTERNAL_KEY) {
    return next();
  }
  // Fall back to requireAuth + requireAdmin
  const { requireAuth, requireAdmin } = await import('./auth-middleware.tsx');
  return requireAuth(c, async () => { await requireAdmin(c, next); });
}


const app = new Hono();

// ElevenLabs API configuration
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

// Voice IDs (ElevenLabs voices)
const VOICE_IDS = {
  neutral: '21m00Tcm4TlvDq8ikWAM', // Rachel (neutral)
  professional: 'AZnzlk1XvdvUeBnXmlld', // Domi (professional)
  energetic: 'EXAVITQu4vr4xnSDxMaL', // Bella (energetic)
  calm: 'ErXwobaYiN019PkySvjV', // Antoni (calm)
  friendly: 'MF3mGyEYCl7XYWbV9V6O', // Elli (friendly)
};

// Voice settings for different styles
const STYLE_SETTINGS = {
  professional: {
    stability: 0.75,
    similarity_boost: 0.75,
    style: 0.5,
    use_speaker_boost: true,
  },
  energetic: {
    stability: 0.5,
    similarity_boost: 0.8,
    style: 0.7,
    use_speaker_boost: true,
  },
  calm: {
    stability: 0.9,
    similarity_boost: 0.7,
    style: 0.3,
    use_speaker_boost: true,
  },
  friendly: {
    stability: 0.65,
    similarity_boost: 0.75,
    style: 0.6,
    use_speaker_boost: true,
  },
};

/**
 * POST /generate
 * Генерирует аудио через ElevenLabs и сохраняет в Storage
 */
app.post('/generate', requireAdminOrKey, async (c) => {
  try {
    const { orderId, customText } = await c.req.json();

    if (!orderId) {
      return c.json({ success: false, error: 'Order ID is required' }, 400);
    }

    console.log('Generating audio for order:', orderId);

    // Получаем заказ из KV
    const _coRow = await elPool.query('SELECT * FROM content_orders WHERE id = $1', [orderId]);
    if (_coRow.rows.length === 0) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    const _r = _coRow.rows[0];
    const order: any = {
      id: _r.id, venueId: _r.venue_id, venueName: _r.venue_name,
      contentType: _r.content_type, text: _r.text, style: _r.style,
      duration: _r.duration, voiceType: _r.voice_type, price: parseFloat(_r.price),
      status: _r.status, audioUrl: _r.audio_url || undefined,
      createdAt: _r.created_at, updatedAt: _r.updated_at,
    };
    
    // Проверяем API ключ
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return c.json({ 
        success: false, 
        error: 'ElevenLabs API key not configured. Please add ELEVENLABS_API_KEY secret.' 
      }, 500);
    }

    // Используем кастомный текст если передан, иначе текст из заказа
    const textToGenerate = customText || order.text;
    console.log('Text to generate:', textToGenerate.slice(0, 100));

    // Определяем voice ID
    const voiceId = VOICE_IDS[order.voiceType] || VOICE_IDS.neutral;
    
    // Определяем настройки стиля
    const voiceSettings = STYLE_SETTINGS[order.style] || STYLE_SETTINGS.professional;

    console.log('Using voice:', voiceId, 'with style:', order.style);

    // Отправляем запрос в ElevenLabs
    const response = await fetch(`${ELEVENLABS_API_URL}/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: textToGenerate,
        model_id: 'eleven_monolingual_v1',
        voice_settings: voiceSettings,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API error:', errorText);
      return c.json({ 
        success: false, 
        error: `ElevenLabs API error: ${response.status} - ${errorText}` 
      }, 500);
    }

    // Получаем аудио данные
    const audioData = await response.arrayBuffer();
    console.log('Audio generated, size:', audioData.byteLength, 'bytes');

    // Сохраняем в storage
    const dbClient = getDbClient();

    // Создаем bucket если не существует
    const bucketName = 'make-84730125-content';
    try {
      const { data: buckets } = await dbClient.storage.listBuckets();
      const bucketExists = buckets?.some(bucket => bucket.name === bucketName);
      
      if (!bucketExists) {
        console.log('Creating storage bucket:', bucketName);
        await dbClient.storage.createBucket(bucketName, { public: false });
      }
    } catch (bucketErr: any) {
      // Storage API may return non-JSON "Internal server error" - try to create bucket anyway
      console.warn('listBuckets failed, attempting createBucket directly:', bucketErr?.message);
      try {
        await dbClient.storage.createBucket(bucketName, { public: false });
      } catch {
        // Bucket may already exist - ignore
      }
    }

    // Генерируем имя файла
    const timestamp = Date.now();
    const fileName = `${order.contentType}/${orderId}_${timestamp}.mp3`;

    console.log('Uploading to storage:', fileName);

    // Загружаем файл
    const { data: uploadData, error: uploadError } = await dbClient.storage
      .from(bucketName)
      .upload(fileName, audioData, {
        contentType: 'audio/mpeg',
        upsert: false,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return c.json({ success: false, error: uploadError.message }, 500);
    }

    console.log('File uploaded:', uploadData.path);

    // Создаем signed URL (действителен 1 год)
    const { data: signedUrlData, error: signedUrlError } = await dbClient.storage
      .from(bucketName)
      .createSignedUrl(fileName, 31536000); // 365 days

    if (signedUrlError) {
      console.error('Signed URL error:', signedUrlError);
      return c.json({ success: false, error: signedUrlError.message }, 500);
    }

    const audioUrl = signedUrlData.signedUrl;
    console.log('Signed URL created');

    // Обновляем заказ
    const updatedOrder = {
      ...order,
      status: 'processing',
      audioUrl,
      generatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await elPool.query(
      'UPDATE content_orders SET status = $1, audio_url = $2, updated_at = NOW() WHERE id = $3',
      [updatedOrder.status, updatedOrder.audioUrl, orderId]
    );

    console.log('Order updated with audio URL');

    return c.json({
      success: true,
      order: updatedOrder,
      audioUrl,
      message: 'Audio generated successfully',
    });

  } catch (error) {
    console.error('Error generating audio:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

/**
 * GET /voices
 * Получает список доступных голосов
 */
app.get('/voices', requireAdminOrKey, async (c) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return c.json({ 
        success: false, 
        error: 'ElevenLabs API key not configured' 
      }, 500);
    }

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': apiKey,
      },
    });

    const data = await response.json();
    
    return c.json({
      success: true,
      voices: data.voices,
    });

  } catch (error) {
    console.error('Error fetching voices:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

export default app;