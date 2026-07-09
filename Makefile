.PHONY: install fixtures seed mocks ingest asana-demo eval agent-eval a2a ui test compose-up

install:
	python -m pip install -e ".[dev,ui,agents]"

fixtures:
	python -m cos.fixtures.generate

seed:
	python -m cos.scripts.seed

ui:
	python -m cos.ui.app

compose-up:
	docker compose up --build

mocks:
	uvicorn cos.mocks.app:app --host $${MOCK_HOST:-127.0.0.1} --port $${MOCK_PORT:-8900} --reload

ingest:
	python -m cos.scripts.ingest

asana-demo:
	python -m cos.scripts.asana_demo

eval:
	python -m cos.eval.harness

agent-eval:
	python -m cos.eval.agent_harness

a2a:
	python -m cos.agents.a2a.launch $(ROLE)

test:
	pytest -q
