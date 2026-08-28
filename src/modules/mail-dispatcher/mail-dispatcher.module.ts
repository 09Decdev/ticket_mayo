import { Module } from '@nestjs/common';
import { env, MailTransport } from '../../config/env';
import { ContentClientModule } from '../content-client/content-client.module';
import { ContentClientService } from '../content-client/content-client.service';
import { ConsoleMailAdapter } from './console-mail.adapter';
import { KafkaProducerAdapter } from './kafka-producer.adapter';
import { MailAdapter } from './mail.adapter';
import { MailDispatcherService } from './mail-dispatcher.service';
import { SmtpMailAdapter } from './smtp-mail.adapter';

@Module({
  imports: [ContentClientModule],
  providers: [
    ConsoleMailAdapter,
    KafkaProducerAdapter,
    SmtpMailAdapter,
    {
      provide: MailDispatcherService,
      useFactory: (
        consoleAdapter: ConsoleMailAdapter,
        kafkaAdapter: KafkaProducerAdapter,
        smtpAdapter: SmtpMailAdapter,
        content: ContentClientService,
      ) => {
        let adapter: MailAdapter = consoleAdapter;
        if (env.MAIL_TRANSPORT === MailTransport.Kafka) adapter = kafkaAdapter;
        else if (env.MAIL_TRANSPORT === MailTransport.Smtp) adapter = smtpAdapter;
        return new MailDispatcherService(adapter, content);
      },
      inject: [ConsoleMailAdapter, KafkaProducerAdapter, SmtpMailAdapter, ContentClientService],
    },
  ],
  exports: [MailDispatcherService],
})
export class MailDispatcherModule {}
