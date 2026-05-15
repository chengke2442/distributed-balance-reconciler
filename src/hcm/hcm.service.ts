import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface HcmSubmitResult {
  success: boolean;
  referenceId?: string;
  error?: string;
}

export interface HcmBalanceRecord {
  employeeId: string;
  locationId: string;
  balanceDays: number;
  timestamp: string;
}

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);
  private readonly client: AxiosInstance;
  private readonly retryCount: number;

  constructor(private readonly configService: ConfigService) {
    this.client = axios.create({
      baseURL: configService.get<string>('HCM_BASE_URL', 'http://localhost:3001'),
      timeout: configService.get<number>('HCM_TIMEOUT_MS', 5000),
    });
    this.retryCount = configService.get<number>('HCM_RETRY_COUNT', 3);
  }

  async submitTimeOffRequest(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<HcmSubmitResult> {
    return this.withRetry(async () => {
      const response = await this.client.post('/hcm/time-off', {
        employeeId,
        locationId,
        days,
      });

      if (!response.data?.referenceId) {
        return { success: false, error: 'HCM returned no confirmation (silent failure)' };
      }

      return { success: true, referenceId: response.data.referenceId };
    });
  }

  async getBatchCorpus(): Promise<HcmBalanceRecord[]> {
    return this.withRetryOrThrow(async () => {
      const response = await this.client.get('/hcm/balances/batch', { timeout: 60000 });
      return response.data;
    });
  }

  // Returns a failure result on error rather than throwing — used for user-facing requests
  // where the caller needs to surface a REJECTED status rather than a 500.
  private async withRetry(fn: () => Promise<HcmSubmitResult>): Promise<HcmSubmitResult> {
    let lastError: Error;
    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isRetryable = !err.response || err.response.status >= 500;
        if (!isRetryable || attempt === this.retryCount) {
          return { success: false, error: err.response?.data?.error ?? err.message };
        }
        const delay = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(`HCM call failed (attempt ${attempt}/${this.retryCount}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return { success: false, error: lastError.message };
  }

  // Retries on 5xx/network errors and re-throws on final failure — used for background operations.
  private async withRetryOrThrow<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error;
    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isRetryable = !err.response || err.response.status >= 500;
        if (!isRetryable || attempt === this.retryCount) throw err;
        const delay = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(`HCM call failed (attempt ${attempt}/${this.retryCount}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}
