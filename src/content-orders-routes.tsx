/**
 * CONTENT ORDERS ROUTES - Система заказа контента (джинглы/реклама/анонсы)
 * 
 * Endpoints:
 * POST   /orders          - Создать заказ (venue)
 * GET    /orders          - Получить заказы (admin/venue)
 * GET    /orders/:id      - Получить заказ по ID
 * PUT    /orders/:id      - Обновить статус заказа (admin)
 * DELETE /orders/:id      - Удалить заказ
 */

import { Hono } from 'hono';
import { contentOrdersStore, contentOrdersByStatusStore, venueOrdersIndexStore } from './db.tsx';
import { safeErrorMessage } from './security.tsx';
import { requireAuth, requireAdmin } from './auth-middleware.tsx';

const app = new Hono();

// Статусы заказа
export type OrderStatus = 
  | 'pending'      // Ожидает обработки админом
  | 'processing'   // В работе (отправлено в ElevenLabs)
  | 'review'       // На проверке у админа
  | 'ready'        // Готов к прослушиванию клиентом
  | 'approved'     // Утвержден клиентом
  | 'revision'     // Требует доработки
  | 'completed'    // Завершен (в эфире)
  | 'cancelled';   // Отменен

export interface ContentOrder {
  id: string;
  venueId: string;
  venueName: string;
  contentType: 'jingles' | 'ads' | 'announcements';
  text: string;
  style: string;
  duration: number;
  voiceType: string;
  price: number;
  status: OrderStatus;
  audioUrl?: string;
  adminComment?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// =====================================================
// CREATE ORDER (Venue)
// =====================================================

app.post("/orders", requireAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { venueId, venueName, contentType, text, style, duration, voiceType, price } = body;

    // Validation
    if (!venueId || !venueName || !contentType || !text || !style || !voiceType || !price) {
      return c.json({ 
        success: false, 
        error: "Missing required fields" 
      }, 400);
    }

    if (!['jingles', 'ads', 'announcements'].includes(contentType)) {
      return c.json({ 
        success: false, 
        error: "Invalid content type" 
      }, 400);
    }

    if (text.length < 10 || text.length > 300) {
      return c.json({ 
        success: false, 
        error: "Text must be between 10 and 300 characters" 
      }, 400);
    }

    const orderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = new Date().toISOString();

    const order: ContentOrder = {
      id: orderId,
      venueId,
      venueName,
      contentType,
      text,
      style,
      duration,
      voiceType,
      price,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Save to DB store
    await contentOrdersStore.set(orderId, order);

    // Add to venue's orders list
    const venueOrders = await venueOrdersIndexStore.get(venueId) || [];
    venueOrders.push(orderId);
    await venueOrdersIndexStore.set(venueId, venueOrders);

    // Add to pending orders list (for admin)
    const pendingOrders = await contentOrdersByStatusStore.get('pending') || [];
    pendingOrders.push(orderId);
    await contentOrdersByStatusStore.set('pending', pendingOrders);

    console.log(`Content order created: ${orderId} (${contentType})`);

    return c.json({
      success: true,
      order,
      message: "Order created successfully"
    }, 201);

  } catch (error) {
    console.error("Error creating content order:", error);
    return c.json({ 
      success: false, 
      error: safeErrorMessage(error) 
    }, 500);
  }
});

// =====================================================
// GET ALL ORDERS (Admin/Venue)
// =====================================================

app.get("/orders", async (c) => {
  try {
    const venueId = c.req.query("venueId");
    const status = c.req.query("status") as OrderStatus | undefined;
    const role = c.req.query("role"); // 'admin' or 'venue'

    console.log('GET /orders - role:', role, 'venueId:', venueId, 'status:', status);

    let orderIds: string[] = [];

    if (role === 'admin') {
      // Admin sees all orders or filtered by status
      if (status) {
        orderIds = await contentOrdersByStatusStore.get(status) || [];
        console.log(`Found ${orderIds.length} orders with status: ${status}`);
      } else {
        // Get all orders
        const allStatuses: OrderStatus[] = ['pending', 'processing', 'review', 'ready', 'approved', 'revision', 'completed', 'cancelled'];
        for (const s of allStatuses) {
          const orders = await contentOrdersByStatusStore.get(s) || [];
          console.log(`Status ${s}: ${orders.length} orders`);
          orderIds.push(...orders);
        }
        console.log(`Total orderIds: ${orderIds.length}`);
      }
    } else if (venueId) {
      // Venue sees only their orders
      orderIds = await venueOrdersIndexStore.get(venueId) || [];
      console.log(`Found ${orderIds.length} orders for venue: ${venueId}`);
    } else {
      console.warn('Missing venueId or role=admin');
      return c.json({ 
        success: false, 
        error: "venueId or role=admin required" 
      }, 400);
    }

    // Fetch all orders
    const orders: ContentOrder[] = [];
    for (const orderId of orderIds) {
      const order = await contentOrdersStore.get(orderId);
      if (order) {
        orders.push(order);
      } else {
        console.warn(`Order not found in KV: ${orderId}`);
      }
    }

    console.log(`Fetched ${orders.length} complete orders from KV`);

    // Filter by status if provided for venue
    const filteredOrders = status 
      ? orders.filter(o => o.status === status)
      : orders;

    // Sort by date (newest first)
    filteredOrders.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    console.log(`Returning ${filteredOrders.length} content orders`);

    return c.json({
      success: true,
      orders: filteredOrders,
      total: filteredOrders.length
    });

  } catch (error) {
    console.error("Error fetching content orders:", error);
    return c.json({ 
      success: false, 
      error: safeErrorMessage(error) 
    }, 500);
  }
});

// =====================================================
// GET ORDER BY ID
// =====================================================

app.get("/orders/:id", requireAuth, async (c) => {
  try {
    const orderId = c.req.param("id");
    const order = await contentOrdersStore.get(orderId);

    if (!order) {
      return c.json({ 
        success: false, 
        error: "Order not found" 
      }, 404);
    }

    return c.json({
      success: true,
      order
    });

  } catch (error) {
    console.error("Error fetching content order:", error);
    return c.json({ 
      success: false, 
      error: safeErrorMessage(error) 
    }, 500);
  }
});

// =====================================================
// UPDATE ORDER STATUS (Admin)
// =====================================================

app.put("/orders/:id", requireAuth, async (c) => {
  try {
    const orderId = c.req.param("id");
    const body = await c.req.json();
    const { status, audioUrl, adminComment } = body;

    const order = await contentOrdersStore.get(orderId) as ContentOrder;

    if (!order) {
      return c.json({ 
        success: false, 
        error: "Order not found" 
      }, 404);
    }

    const oldStatus = order.status;

    // Update order
    const updatedOrder: ContentOrder = {
      ...order,
      ...(status && { status }),
      ...(audioUrl && { audioUrl }),
      ...(adminComment !== undefined && { adminComment }),
      updatedAt: new Date().toISOString(),
      ...(status === 'completed' && { completedAt: new Date().toISOString() }),
    };

    await contentOrdersStore.set(orderId, updatedOrder);

    // Update status lists if status changed
    if (status && status !== oldStatus) {
      // Remove from old status list
      const oldStatusOrders = await contentOrdersByStatusStore.get(oldStatus) || [];
      const filteredOldOrders = oldStatusOrders.filter((id: string) => id !== orderId);
      await contentOrdersByStatusStore.set(oldStatus, filteredOldOrders);

      // Add to new status list
      const newStatusOrders = await contentOrdersByStatusStore.get(status) || [];
      if (!newStatusOrders.includes(orderId)) {
        newStatusOrders.push(orderId);
        await contentOrdersByStatusStore.set(status, newStatusOrders);
      }
    }

    console.log(`Order ${orderId} updated: ${oldStatus} → ${status || oldStatus}`);

    return c.json({
      success: true,
      order: updatedOrder,
      message: "Order updated successfully"
    });

  } catch (error) {
    console.error("Error updating content order:", error);
    return c.json({ 
      success: false, 
      error: safeErrorMessage(error) 
    }, 500);
  }
});

// =====================================================
// DELETE ORDER
// =====================================================

app.delete("/orders/:id", async (c) => {
  try {
    const orderId = c.req.param("id");
    const order = await contentOrdersStore.get(orderId) as ContentOrder;

    if (!order) {
      return c.json({ 
        success: false, 
        error: "Order not found" 
      }, 404);
    }

    // Remove from all lists
    await contentOrdersStore.del(orderId);

    // Remove from venue orders
    const venueOrders = await venueOrdersIndexStore.get(order.venueId) || [];
    await venueOrdersIndexStore.set(order.venueId, venueOrders.filter((id: string) => id !== orderId));

    // Remove from status list
    const statusOrders = await contentOrdersByStatusStore.get(order.status) || [];
    await contentOrdersByStatusStore.set(order.status, statusOrders.filter((id: string) => id !== orderId));

    console.log(`Order ${orderId} deleted`);

    return c.json({
      success: true,
      message: "Order deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting content order:", error);
    return c.json({ 
      success: false, 
      error: safeErrorMessage(error) 
    }, 500);
  }
});

// =====================================================
// GET STATS (Admin Dashboard)
// =====================================================

app.get("/stats", async (c) => {
  try {
    const statuses: OrderStatus[] = ['pending', 'processing', 'review', 'ready', 'approved', 'revision', 'completed', 'cancelled'];
    
    const stats: Record<string, number> = {};
    let total = 0;

    for (const status of statuses) {
      const orders = await contentOrdersByStatusStore.get(status) || [];
      stats[status] = orders.length;
      total += orders.length;
    }

    return c.json({
      success: true,
      stats,
      total
    });

  } catch (error) {
    console.error("Error fetching stats:", error);
    return c.json({ 
      success: false, 
      error: safeErrorMessage(error) 
    }, 500);
  }
});

// Demo endpoint removed — use real order creation via POST /

export default app;