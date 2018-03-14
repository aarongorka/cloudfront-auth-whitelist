

deploy: .env config.json
	docker-compose run --rm serverless make _deploy
.PHONY: deploy

_deploy:
	rm -fr .serverless
	sls deploy -v

.env:
	@echo "Create .env with .env.template"
	cp .env.template .env

config.json:
	docker-compose run --rm envsubst config.json.template > config.json

clean:
	rm -fr config.json
