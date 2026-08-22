.PHONY: test test-migrations test-videos lint typecheck up down

up:
	cd nestjs-project && docker compose up -d

down:
	cd nestjs-project && docker compose down

test:
	cd nestjs-project && docker compose exec -T nestjs-api npm test -- --runInBand

test-migrations:
	cd nestjs-project && docker compose exec -T nestjs-api npx jest src/database/migrations.integration-spec.ts --runInBand

test-videos:
	cd nestjs-project && docker compose exec -T nestjs-api npm test -- src/videos --runInBand

typecheck:
	cd nestjs-project && docker compose exec -T nestjs-api npx tsc --noEmit

lint:
	cd nestjs-project && docker compose exec -T nestjs-api npm run lint
