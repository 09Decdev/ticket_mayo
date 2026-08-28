export const KafkaTopics = {
  SendTicket: 'notification.send-ticket',
  MailDeadLetter: 'mail-dead-letter',
} as const;

export type KafkaTopic = (typeof KafkaTopics)[keyof typeof KafkaTopics];
