import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { env } from '../../config/env';
import { KafkaTopics } from '../../common/constants/kafka-topics';
import { ClaimMailPayload, MailAdapter } from './mail.adapter';

/**
 * Kafka adapter — produces to `notification.send-ticket`. Disabled (no-op) when
 * KAFKA_BROKERS is unset, so the app still boots in console mode even if this
 * provider is always registered. Connect failures never throw (mail falls back
 * to failed count).
 */
@Injectable()
export class KafkaProducerAdapter implements OnModuleInit, OnModuleDestroy, MailAdapter {
  private readonly logger = new Logger(KafkaProducerAdapter.name);
  private kafka?: Kafka;
  private producer?: Producer;
  private connected = false;

  constructor() {
    const brokers = env.KAFKA_BROKERS;
    if (!brokers) {
      this.logger.warn('KAFKA_BROKERS not set — kafka mail adapter disabled');
      return;
    }
    this.kafka = new Kafka({
      clientId: 'ticket-mayo',
      brokers: brokers.split(',').map((b) => b.trim()).filter(Boolean),
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.kafka) return;
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.connected || !this.kafka) return;
    this.producer = this.kafka.producer();
    try {
      await this.producer.connect();
      this.connected = true;
      this.logger.log(`Kafka producer connected to ${env.KAFKA_BROKERS}`);
    } catch (err) {
      this.logger.error(`Kafka producer connect failed: ${(err as Error).message}`);
    }
  }

  private async disconnect(): Promise<void> {
    if (!this.connected || !this.producer) return;
    try {
      await this.producer.disconnect();
    } finally {
      this.connected = false;
      this.producer = undefined;
    }
  }

  async send(payload: ClaimMailPayload): Promise<void> {
    if (!this.producer || !this.connected) {
      throw new Error('Kafka producer not connected');
    }
    await this.producer.send({
      topic: KafkaTopics.SendTicket,
      compression: CompressionTypes.None,
      messages: [
        {
          key: payload.claimToken,
          value: JSON.stringify(payload),
          headers: { source: 'ticket-mayo' },
        },
      ],
    });
  }
}
