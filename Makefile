ifdef AWS_ROLE
       ASSUME_REQUIRED?=assumeRole
endif

deploy: .env config.json $(ASSUME_REQUIRED)
	docker-compose run --rm serverless make _deploy
.PHONY: deploy

_deploy:
	rm -fr .serverless
	sls deploy -v

.env:
	@echo "Create .env with .env.template"
	cp .env.template .env

config.json:
	docker-compose pull envsubst
	docker-compose run --rm envsubst config.json.template > config.json

clean:
	rm -fr config.json

assumeRole: .env
	docker run --rm -e "AWS_ACCOUNT_ID" -e "AWS_ROLE" amaysim/aws:1.1.3 assume-role.sh >> .env
.PHONY: assumeRole
