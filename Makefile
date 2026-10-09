.DEFAULT_GOAL := build

CARGO ?= cargo
MANIFEST := server/Cargo.toml
VERSION := $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' $(MANIFEST) | head -n 1)
TARGET ?= $(shell rustc -vV | sed -n 's/^host: //p')
PACKAGE := securevault-$(VERSION)-$(TARGET)

.PHONY: build debug run check test package clean help

build:
	$(CARGO) build --locked --release --manifest-path $(MANIFEST) --target $(TARGET)

debug:
	$(CARGO) build --locked --manifest-path $(MANIFEST)

run:
	$(CARGO) run --locked --manifest-path $(MANIFEST) -- $(ARGS)

check:
	$(CARGO) check --locked --manifest-path $(MANIFEST)

test:
	$(CARGO) test --locked --manifest-path $(MANIFEST) --target $(TARGET)

package: build
	mkdir -p "dist/$(PACKAGE)"
	cp "server/target/$(TARGET)/release/securevault" "dist/$(PACKAGE)/securevault"
	rm -rf "dist/$(PACKAGE)/web"
	rm -f "dist/$(PACKAGE)/README.md"
	tar -czf "dist/$(PACKAGE).tar.gz" -C dist "$(PACKAGE)"

clean:
	$(CARGO) clean --manifest-path $(MANIFEST)
	rm -rf dist

help:
	@echo "make [build|debug|run|check|test|package|clean]"
	@echo "Override TARGET for a Rust target; pass ARGS to make run."
