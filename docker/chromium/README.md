# Norish Chromium image

`norishapp/chromium` runs [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium),
a BSD-3 build of ungoogled-chromium that spoofs its browser fingerprint, as a
headless CDP server on port 9222. Norish's Chromium browser Page Renderer
connects to it to read pages that Obscura gets a bot check on, such as
Allerhande's recipes.

It is linux/amd64 only, because upstream builds Linux for x86_64 only. Give the
container 1 GB of shared memory (`shm_size`): with Docker's default 64 MB it
crashes under concurrent renders. Each start gets a new fingerprint seed and an
empty profile. Chromium runs without its own sandbox, which Docker's default
seccomp profile refuses.

## The pin

`pin.env` records the upstream release, its archive and digest, and the image
tag. The Dockerfile's `ARG` defaults carry the same values. To upgrade, change
both, bump `CHROMIUM_IMAGE_TAG` and the tag in `docker/docker-compose.example.yml`,
and push. The **Publish Chromium image** workflow publishes a tag the registry
does not have, refuses to overwrite one it has, and moves `latest` from `main`.

```bash
set -a; . docker/chromium/pin.env; set +a
docker build --platform linux/amd64 docker/chromium -t "norishapp/chromium:$CHROMIUM_IMAGE_TAG"
```

## Licensing

fingerprint-chromium and Chromium are BSD-3. The image carries both licences
under `/licenses/fingerprint-chromium/`, and Chromium's third-party notices are
in the binary at `chrome://credits`. Upstream publishes a release's source
patches about a month later, with the next release.
