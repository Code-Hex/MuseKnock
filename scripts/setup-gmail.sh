#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--dry-run] PROJECT_ID https://YOUR-WORKER.workers.dev" >&2
}

dry_run=false
if [[ ${1:-} == --dry-run ]]; then
  dry_run=true
  shift
fi
if [[ $# -ne 2 ]]; then usage; exit 2; fi
project=$1
origin=${2%/}
if [[ ! $project =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ || ! $origin =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
  usage
  exit 2
fi

topic="projects/$project/topics/museknock-gmail"
subscription="projects/$project/subscriptions/museknock-gmail-push"
push_account="museknock-gmail-push@$project.iam.gserviceaccount.com"
endpoint="$origin/hooks/gmail"

cloud() {
  if $dry_run; then
    printf 'gcloud'
    printf ' %q' "$@" "--project=$project" --quiet
    printf '\n'
  else
    gcloud "$@" "--project=$project" --quiet
  fi
}

cloud services enable gmail.googleapis.com pubsub.googleapis.com iam.googleapis.com iamcredentials.googleapis.com
cloud beta services identity create --service=pubsub.googleapis.com

if $dry_run; then
  project_number=PROJECT_NUMBER
  existing_account=''
  existing_topic=''
  subscription_topic=''
else
  project_number=$(cloud projects describe "$project" --format='value(projectNumber)')
  existing_account=$(cloud iam service-accounts list --filter="email=$push_account" --format='value(email)')
  existing_topic=$(cloud pubsub topics list --filter="name=$topic" --format='value(name)')
  subscription_topic=$(cloud pubsub subscriptions list --filter="name=$subscription" --format='value(topic)')
fi

if [[ -n $subscription_topic && $subscription_topic != "$topic" ]]; then
  echo "$subscription already uses a different topic: $subscription_topic" >&2
  exit 1
fi
if [[ -z $existing_account ]]; then
  cloud iam service-accounts create museknock-gmail-push --display-name='MuseKnock Gmail push'
fi
if [[ -z $existing_topic ]]; then
  cloud pubsub topics create "$topic"
fi
cloud pubsub topics add-iam-policy-binding "$topic" \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher
cloud iam service-accounts add-iam-policy-binding "$push_account" \
  --member="serviceAccount:service-$project_number@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator

push_flags=(--push-endpoint="$endpoint" --push-auth-service-account="$push_account" --push-auth-token-audience="$endpoint")
if [[ -z $subscription_topic ]]; then
  cloud pubsub subscriptions create "$subscription" --topic="$topic" --ack-deadline=60 --expiration-period=never "${push_flags[@]}"
else
  cloud pubsub subscriptions modify-push-config "$subscription" "${push_flags[@]}"
fi

cat <<SETTINGS

Worker settings:
GMAIL_TOPIC=$topic
GMAIL_SUBSCRIPTION=$subscription
GMAIL_PUSH_SERVICE_ACCOUNT=$push_account
GMAIL_PUSH_AUDIENCE=$endpoint
SETTINGS
