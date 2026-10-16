/**
 * Standardized API error codes.
 * All routes should use these for consistent error responses.
 *
 * Format: { success: false, error: string, code: string, status: number }
 */

export const ERROR_CODES = {
  // Auth errors
  AUTH_REQUIRED: { code: "AUTH_REQUIRED", message: "Требуется авторизация", status: 401 },
  AUTH_INVALID_TOKEN: { code: "AUTH_INVALID_TOKEN", message: "Недействительный токен", status: 401 },
  AUTH_TOKEN_EXPIRED: { code: "AUTH_TOKEN_EXPIRED", message: "Токен истёк", status: 401 },
  AUTH_WRONG_PASSWORD: { code: "AUTH_WRONG_PASSWORD", message: "Неверный пароль", status: 403 },
  AUTH_ACCOUNT_LOCKED: { code: "AUTH_ACCOUNT_LOCKED", message: "Аккаунт заблокирован", status: 423 },
  AUTH_INSUFFICIENT_ROLE: { code: "AUTH_INSUFFICIENT_ROLE", message: "Недостаточно прав", status: 403 },
  AUTH_ACCESS_DENIED: { code: "AUTH_ACCESS_DENIED", message: "Доступ запрещён", status: 403 },

  // Validation errors
  VALIDATION_REQUIRED_FIELDS: { code: "VALIDATION_REQUIRED_FIELDS", message: "Заполните обязательные поля", status: 400 },
  VALIDATION_INVALID_EMAIL: { code: "VALIDATION_INVALID_EMAIL", message: "Некорректный email", status: 400 },
  VALIDATION_INVALID_FORMAT: { code: "VALIDATION_INVALID_FORMAT", message: "Некорректный формат данных", status: 400 },
  VALIDATION_INVALID_BODY: { code: "VALIDATION_INVALID_BODY", message: "Некорректное тело запроса", status: 400 },
  VALIDATION_PASSWORD_TOO_SHORT: { code: "VALIDATION_PASSWORD_TOO_SHORT", message: "Пароль должен быть не менее 8 символов", status: 400 },
  VALIDATION_INVALID_LAYER: { code: "VALIDATION_INVALID_LAYER", message: "Некорректный слой памяти", status: 400 },

  // Resource errors
  NOT_FOUND: { code: "NOT_FOUND", message: "Ресурс не найден", status: 404 },
  ALREADY_EXISTS: { code: "ALREADY_EXISTS", message: "Ресурс уже существует", status: 409 },
  ALREADY_PROCESSED: { code: "ALREADY_PROCESSED", message: "Уже обработано", status: 400 },
  BOOKING_DISABLED: { code: "BOOKING_DISABLED", message: "Букинг отключён", status: 400 },
  CANNOT_CANCEL: { code: "CANNOT_CANCEL", message: "Невозможно отменить", status: 400 },
  CANCEL_REQUIRES_ADMIN: {
    code: "CANCEL_REQUIRES_ADMIN",
    message: "Депозит уже оплачен – отмена возможна только через поддержку (возврат средств)",
    status: 409,
  },

  // Rate limiting
  RATE_LIMIT: { code: "RATE_LIMIT", message: "Слишком много запросов", status: 429 },

  // Payment errors
  PAYMENT_FAILED: { code: "PAYMENT_FAILED", message: "Ошибка оплаты", status: 402 },
  PAYMENT_INVALID_GATEWAY: { code: "PAYMENT_INVALID_GATEWAY", message: "Неизвестный платёжный шлюз", status: 400 },
  DEPOSIT_ALREADY_PAID: { code: "DEPOSIT_ALREADY_PAID", message: "Депозит уже оплачен", status: 400 },
  DEPOSIT_REQUIRED: { code: "DEPOSIT_REQUIRED", message: "Сначала оплатите депозит", status: 400 },
  FINAL_ALREADY_PAID: { code: "FINAL_ALREADY_PAID", message: "Финальный платёж уже выполнен", status: 400 },

  // Server errors
  INTERNAL_ERROR: { code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера", status: 500 },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Create a standardized error response.
 * Usage: return apiError(c, 'AUTH_REQUIRED')
 *        return apiError(c, 'NOT_FOUND', 'Трек не найден')
 */
export function apiError(c: any, code: ErrorCode, customMessage?: string) {
  // Опечатка в коде не должна превращать аккуратный 400 в краш 500:
  // раньше ERROR_CODES[неизвестный] === undefined и обращение к .message падало.
  const err = ERROR_CODES[code] ?? ERROR_CODES.INTERNAL_ERROR;
  if (!ERROR_CODES[code]) console.error(`[apiError] неизвестный код ошибки: ${code}`);
  return c.json(
    {
      success: false,
      error: customMessage || err.message,
      code: err.code,
    },
    err.status
  );
}

/**
 * Create a standardized success response.
 * Usage: return apiSuccess(c, data)
 */
export function apiSuccess(c: any, data: any, status = 200) {
  return c.json({ success: true, data }, status);
}
