/**
 * TICKETING SYSTEMS INTEGRATION API ROUTES
 * Интеграция с билетными системами и продажами
 */

import { Hono } from 'hono';
import { getAllConcerts, getTicketProvidersByConcert, getTicketSalesByConcert, ticketSalesStore, upsertTicketProvider, upsertTicketSale } from './db.tsx';

const ticketing = new Hono();

// Типы для билетной системы
export interface TicketProvider {
  id: string;
  name: string;
  apiKey?: string;
  enabled: boolean;
  commission: number; // процент комиссии
  logo?: string;
}

export interface TicketSale {
  id: string;
  concertId: string;
  artistId: string;
  provider: string;
  quantity: number;
  price: number;
  totalAmount: number;
  commission: number;
  netAmount: number;
  buyerEmail?: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'refunded';
  purchasedAt: string;
  metadata?: Record<string, any>;
}

export interface SalesFunnel {
  concertId: string;
  views: number;
  clicks: number;
  cartAdds: number;
  checkoutInitiated: number;
  purchases: number;
  revenue: number;
  conversionRate: number;
  averageTicketPrice: number;
}

// Популярные билетные системы
const TICKET_PROVIDERS: TicketProvider[] = [
  {
    id: 'kassir',
    name: 'Кассир.ру',
    enabled: true,
    commission: 5,
    logo: 'https://images.unsplash.com/photo-1594122230689-45899d9e6f69?w=100&h=100&fit=crop',
  },
  {
    id: 'ticketland',
    name: 'Ticketland.ru',
    enabled: true,
    commission: 7,
    logo: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=100&h=100&fit=crop',
  },
  {
    id: 'afisha',
    name: 'Афиша',
    enabled: true,
    commission: 8,
    logo: 'https://images.unsplash.com/photo-1557804506-669a67965ba0?w=100&h=100&fit=crop',
  },
  {
    id: 'ticketmaster',
    name: 'TicketMaster',
    enabled: false,
    commission: 10,
    logo: 'https://images.unsplash.com/photo-1533750516457-a7f992034fec?w=100&h=100&fit=crop',
  },
];

// Получить список провайдеров
ticketing.get('/providers', async (c) => {
  try {
    return c.json({ success: true, data: TICKET_PROVIDERS });
  } catch (error) {
    console.error('Error fetching providers:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch providers' 
    }, 500);
  }
});

// Подключить провайдера
ticketing.post('/providers/:providerId/connect', async (c) => {
  try {
    const providerId = c.req.param('providerId');
    const body = await c.req.json();
    const artistId = body.artistId;
    
    const provider = TICKET_PROVIDERS.find(p => p.id === providerId);
    if (!provider) {
      return c.json({ success: false, error: 'Provider not found' }, 404);
    }
    
    const connection = {
      ...provider,
      artistId,
      apiKey: body.apiKey,
      connectedAt: new Date().toISOString(),
    };
    
    await upsertTicketProvider(artistId, providerId, connection);
    
    return c.json({ 
      success: true, 
      data: connection,
      message: `Подключено к ${provider.name}!`
    });
  } catch (error) {
    console.error('Error connecting provider:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to connect provider' 
    }, 500);
  }
});

// Получить подключённых провайдеров артиста
ticketing.get('/providers/connected/:artistId', async (c) => {
  try {
    const artistId = c.req.param('artistId');
    const connections = await getTicketProvidersByConcert(artistId);
    
    return c.json({ success: true, data: connections });
  } catch (error) {
    console.error('Error fetching connected providers:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch connections' 
    }, 500);
  }
});

// Создать продажу билета (webhook или мануальная запись)
ticketing.post('/sales', async (c) => {
  try {
    const body = await c.req.json();
    
    const sale: TicketSale = {
      id: `sale_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      concertId: body.concertId,
      artistId: body.artistId,
      provider: body.provider || 'manual',
      quantity: body.quantity || 1,
      price: body.price,
      totalAmount: body.price * (body.quantity || 1),
      commission: 0,
      netAmount: 0,
      buyerEmail: body.buyerEmail,
      status: body.status || 'confirmed',
      purchasedAt: new Date().toISOString(),
      metadata: body.metadata || {},
    };
    
    // Вычисляем комиссию
    const provider = TICKET_PROVIDERS.find(p => p.id === body.provider);
    if (provider) {
      sale.commission = sale.totalAmount * (provider.commission / 100);
      sale.netAmount = sale.totalAmount - sale.commission;
    } else {
      sale.netAmount = sale.totalAmount;
    }
    
    await upsertTicketSale(sale.concertId, sale.id, sale);
    
    return c.json({ success: true, data: sale });
  } catch (error) {
    console.error('Error creating sale:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to create sale' 
    }, 500);
  }
});

// Получить все продажи концерта
ticketing.get('/sales/:concertId', async (c) => {
  try {
    const concertId = c.req.param('concertId');
    const sales = await getTicketSalesByConcert(concertId);
    
    return c.json({ success: true, data: sales });
  } catch (error) {
    console.error('Error fetching sales:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch sales' 
    }, 500);
  }
});

// Получить статистику продаж
ticketing.get('/sales/:concertId/stats', async (c) => {
  try {
    const concertId = c.req.param('concertId');
    const sales = await getTicketSalesByConcert(concertId);
    
    const confirmedSales = sales.filter(s => s.status === 'confirmed');
    
    const stats = {
      totalSales: confirmedSales.length,
      totalTickets: confirmedSales.reduce((sum, s) => sum + s.quantity, 0),
      totalRevenue: confirmedSales.reduce((sum, s) => sum + s.totalAmount, 0),
      totalCommission: confirmedSales.reduce((sum, s) => sum + s.commission, 0),
      netRevenue: confirmedSales.reduce((sum, s) => sum + s.netAmount, 0),
      averageTicketPrice: confirmedSales.length > 0 
        ? confirmedSales.reduce((sum, s) => sum + s.price, 0) / confirmedSales.length 
        : 0,
      byProvider: {} as Record<string, number>,
    };
    
    // Группировка по провайдерам
    confirmedSales.forEach(sale => {
      if (!stats.byProvider[sale.provider]) {
        stats.byProvider[sale.provider] = 0;
      }
      stats.byProvider[sale.provider] += sale.quantity;
    });
    
    return c.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error fetching sales stats:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch stats' 
    }, 500);
  }
});

// Получить воронку продаж (Sales Funnel)
ticketing.get('/funnel/:concertId', async (c) => {
  try {
    const concertId = c.req.param('concertId');
    
    // Получаем данные о концерте (views, clicks из concerts-routes)
    const allConcerts = await getAllConcerts();
    const currentConcert = allConcerts.find((c: any) => c.id === concertId);
    
    if (!currentConcert) {
      return c.json({ success: false, error: 'Concert not found' }, 404);
    }
    
    const sales = await getTicketSalesByConcert(concertId);
    const confirmedSales = sales.filter(s => s.status === 'confirmed');
    
    const views = currentConcert.views || 0;
    const clicks = currentConcert.clicks || 0;
    const purchases = confirmedSales.length;
    const revenue = confirmedSales.reduce((sum, s) => sum + s.totalAmount, 0);
    
    // Мок данных для полной воронки (в реальности нужна интеграция с аналитикой)
    const cartAdds = Math.floor(clicks * 0.6); // 60% кликов добавляют в корзину
    const checkoutInitiated = Math.floor(cartAdds * 0.7); // 70% начинают оформление
    
    const funnel: SalesFunnel = {
      concertId,
      views,
      clicks,
      cartAdds,
      checkoutInitiated,
      purchases,
      revenue,
      conversionRate: views > 0 ? (purchases / views) * 100 : 0,
      averageTicketPrice: purchases > 0 ? revenue / purchases : 0,
    };
    
    return c.json({ success: true, data: funnel });
  } catch (error) {
    console.error('Error fetching funnel:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch funnel' 
    }, 500);
  }
});

// Генерация тестовых продаж (для демонстрации)
ticketing.post('/generate-test-sales/:concertId', async (c) => {
  try {
    const concertId = c.req.param('concertId');
    const body = await c.req.json();
    const artistId = body.artistId;
    const count = body.count || 10;
    
    const sales: TicketSale[] = [];
    const providers = ['kassir', 'ticketland', 'afisha'];
    
    for (let i = 0; i < count; i++) {
      const provider = providers[Math.floor(Math.random() * providers.length)];
      const providerData = TICKET_PROVIDERS.find(p => p.id === provider)!;
      const price = Math.floor(Math.random() * 3000) + 500; // 500-3500₽
      const quantity = Math.floor(Math.random() * 3) + 1; // 1-3 билета
      const totalAmount = price * quantity;
      const commission = totalAmount * (providerData.commission / 100);
      
      const sale: TicketSale = {
        id: `sale_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 9)}`,
        concertId,
        artistId,
        provider,
        quantity,
        price,
        totalAmount,
        commission,
        netAmount: totalAmount - commission,
        buyerEmail: `user${i}@example.com`,
        status: 'confirmed',
        purchasedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
        metadata: { test: true },
      };
      
      await upsertTicketSale(concertId, sale.id, sale);
      sales.push(sale);
    }
    
    return c.json({ 
      success: true, 
      data: sales,
      message: `Создано ${count} тестовых продаж`
    });
  } catch (error) {
    console.error('Error generating test sales:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to generate sales' 
    }, 500);
  }
});

// Отменить продажу
ticketing.put('/sales/:saleId/cancel', async (c) => {
  try {
    const saleId = c.req.param('saleId');
    const body = await c.req.json();
    const concertId = body.concertId;
    
    const sale = await ticketSalesStore.get(saleId) as TicketSale;
    
    if (!sale) {
      return c.json({ success: false, error: 'Sale not found' }, 404);
    }
    
    sale.status = 'cancelled';
    await upsertTicketSale(concertId, saleId, sale);
    
    return c.json({ success: true, data: sale });
  } catch (error) {
    console.error('Error cancelling sale:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to cancel sale' 
    }, 500);
  }
});

export default ticketing;
