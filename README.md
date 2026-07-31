# local-review-bot

Gitea/GitHub/GitLab의 오픈 PR 중 Android 관련 변경(`.kt`, `.java`, `gradle`)을 감지해 로컬 Ollama 모델로 자동 리뷰 댓글을 다는 봇.

## 준비물

- [Ollama](https://ollama.com) 설치 후 리뷰용 모델 pull (예: `ollama pull qwen2.5-coder:14b`)
- Git 호스팅 서버(Gitea/GitHub/GitLab)의 API 토큰

## 설정

```bash
cp .env.example .env
```

`.env`를 실제 값으로 채웁니다.

| 변수 | 설명 |
|---|---|
| `GIT_PROVIDER` | `gitea` \| `github` \| `gitlab` |
| `GIT_URL` | 호스팅 서버 루트 주소 (저장소 경로 제외). 생략 시 provider별 기본 호스트 사용 |
| `GIT_TOKEN` | API 토큰. PR 조회 + 댓글 작성 권한 필요 (Gitea 기준 `read:repository`, `read:issue`, `write:issue`) |
| `REPO_OWNER` / `REPO_NAME` | 저장소 소유자/이름 |
| `OLLAMA_URL` | 기본 `http://localhost:11434` |
| `OLLAMA_MODEL` | 로컬에 pull 받은 모델명 |
| `REVIEW_INTERVAL` | 폴링 주기(초), 기본 300 |

## 실행

```bash
npm install
npm run review:once   # 단발 실행
npm run dev            # 폴링 실행 (REVIEW_INTERVAL마다 반복)
npm run build && npm start   # 빌드 후 실행
```

`npm run dev`는 포그라운드에서 `REVIEW_INTERVAL`마다 계속 폴링하는 프로세스입니다. 종료하려면:

- 실행 중인 터미널에서 `Ctrl + C`
- 백그라운드(`&`, `nohup` 등)로 띄운 경우:
  ```bash
  ps aux | grep pr-reviewer
  kill <PID>
  ```

## 리뷰 페르소나

[CLAUDE.md](CLAUDE.md) 내용이 그대로 리뷰 모델의 시스템 프롬프트에 들어갑니다. 팀 리뷰 기준을 바꾸려면 코드가 아니라 이 파일만 수정하면 됩니다.

## DB 초기화

이미 리뷰한 PR은 `pr-reviewer.db`(SQLite)에 기록되어 중복 리뷰하지 않습니다. 초기화하려면:

```bash
npm run db:reset
```
