#!/bin/bash
# Creates the SQS FIFO queues used by the service. Runs when LocalStack is ready.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

awslocal sqs create-queue --region "$REGION" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" \
  --queue-url "$(awslocal sqs get-queue-url --region "$REGION" --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --region "$REGION" \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

awslocal sqs create-queue --region "$REGION" \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues created"
