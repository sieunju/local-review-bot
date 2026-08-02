# local-review-bot

Gitea/GitHub/GitLab의 오픈 PR 중 Android 관련 변경(`.kt`, `.java`, `gradle`)을 감지해 로컬 Ollama 모델로 자동 리뷰 댓글을 다는 봇.

## 왜 폴링 방식인가

일종의 그림자 분신술이다. 내가 못 보는 사이에 제2의 내가 PR을 읽고 리뷰를 대신 달아준다.

원래 이런 건 웹훅으로 짜는 게 정석이다. Gitea/GitHub/GitLab 다 웹훅 잘 지원하고, 그게 훨씬 효율적이라는 것도 안다. 근데 이 프로젝트는 어차피 toy project이고, 웹훅은 매번 서버마다 등록해줘야 하고 여러 환경(로컬 Gitea, 회사 GitHub, 어디 GitLab...)을 오갈 걸 생각하니 "그냥 몇 초마다 물어보면 되지 않나?" 싶었다. 웹훅 세팅하는 게 왠지 좀 정석대로 사는 것 같아서(홍대병처럼) 굳이 폴링으로 만들어봤다. 비효율의 낭만이랄까.

그래서 서버 하나 안 걸고, 리버스 프록시도 없이, 그냥 `REVIEW_INTERVAL`초마다 "오픈 PR 있나요?" 물어보고 없으면 자러가고 있으면 리뷰 쓰는 아주 원시적인 구조다.

## 준비물

- [Ollama](https://ollama.com) 설치 후 리뷰용 모델 pull (예: `ollama pull qwen2.5-coder:14b`)
- Git 호스팅 서버(Gitea/GitHub/GitLab)의 API 토큰

## 설정

```bash
cp .env.example .env
```

`.env`를 실제 값으로 채웁니다.

| 변수                       | 설명                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `GIT_PROVIDER`             | `gitea` \| `github` \| `gitlab`                                                                     |
| `GIT_URL`                  | 호스팅 서버 루트 주소 (저장소 경로 제외). 생략 시 provider별 기본 호스트 사용                       |
| `GIT_TOKEN`                | API 토큰. PR 조회 + 댓글 작성 권한 필요 (Gitea 기준 `read:repository`, `read:issue`, `write:issue`) |
| `REPO_OWNER` / `REPO_NAME` | 저장소 소유자/이름                                                                                  |
| `OLLAMA_URL`               | 기본 `http://localhost:11434`                                                                       |
| `OLLAMA_MODEL`             | 로컬에 pull 받은 모델명                                                                             |
| `REVIEW_INTERVAL`          | 폴링 주기(초), 기본 300                                                                             |

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

[REFERENCE.md](REFERENCE.md)가 있으면 `CLAUDE.md` 뒤에 이어붙여서 같이 시스템 프롬프트에 포함됩니다. 로컬 모델이 스스로 찾아볼 수 없는 라이브러리 지식(OkHttp/Retrofit, RxJava-Flow, Lifecycle, Room, MVVM/MVI, 모듈화 등)을 미리 주입하는 용도입니다. 없어도 정상 동작합니다.

## 인라인 리뷰 코멘트

리뷰는 PR 전체에 대한 코멘트 하나가 아니라, Ollama가 `{summary, comments: [{file, line, body}]}` 형태의 JSON으로 응답하면 실제 diff의 해당 줄에 인라인 코멘트로 등록됩니다 (Gitea/GitHub는 PR review API, GitLab은 discussions API 사용). 모델이 JSON이 아닌 응답을 주면 자동으로 summary만 남기고 일반 리뷰 코멘트로 대체됩니다.

## DB 초기화

이미 리뷰한 PR은 `pr-reviewer.db`(SQLite)에 기록되어 중복 리뷰하지 않습니다. 초기화하려면:

```bash
npm run db:reset
```
