# Ollama PR Reviewer - Android 라이브러리 지식 내장

**외부 리서치 불가능한 특수 환경에서 Ollama에게 핵심 개념을 직접 주입하는 방법**

---

## 📚 Android 라이브러리 핵심 가이드

### OkHttp3 (v5.4.0+)

**목적**: HTTP 클라이언트

**핵심 구조**:
```
OkHttpClient (빌더 패턴)
├─ Interceptors (Request/Response 조작)
│  ├─ Application Interceptor (자동 리트라이)
│  └─ Network Interceptor (실제 네트워크 전)
├─ ConnectionPool (연결 재사용)
├─ TimeOut 설정 (connect, read, write)
└─ Dispatcher (스레드 풀 관리)

주요 메서드:
- newCall(request).execute() → 동기
- newCall(request).enqueue(callback) → 비동기
```

**체크 포인트**:
- ❌ `HttpUrlConnection` 직접 사용 (OkHttp 대체 가능)
- ❌ Timeout 미설정 (무한 대기)
- ❌ 모든 요청마다 `OkHttpClient` 새로 생성
- ✅ 싱글톤 또는 DI로 클라이언트 재사용
- ✅ Interceptor로 공통 헤더, 로깅, 인증 처리
- ✅ ConnectionPool 활성화 (기본값 최적)

**코드 예**:
```kotlin
❌ 나쁜 예
fun fetch() {
    val client = OkHttpClient()  // 매번 생성
    val request = Request.Builder()
        .url("https://api.com/data")
        .build()
    client.newCall(request).execute()
}

✅ 좋은 예
object HttpClientFactory {
    val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(LoggingInterceptor())
        .build()
}
```

---

### Retrofit2

**목적**: REST API 클라이언트 (OkHttp 위에 구축)

**핵심**:
```
Retrofit (빌더 패턴)
├─ baseUrl("https://api.example.com/")
├─ addConverterFactory(GsonConverterFactory)
├─ addCallAdapterFactory(RxJavaCallAdapterFactory)
└─ client(okHttpClient)

Service 인터페이스:
@GET("/users/{id}")
fun getUser(@Path("id") id: Int): Call<User>
```

**체크 포인트**:
- ❌ 쿼리 파라미터를 URL에 직접 붙임 (`?key=value`)
- ❌ Response 처리 누락 (성공/실패 구분 없음)
- ❌ 매번 Retrofit 인스턴스 생성
- ✅ @Query, @Path, @Body 활용
- ✅ CallAdapter로 Flow/Observable 지원
- ✅ 에러 처리: HttpException 명시적 처리

**코드 예**:
```kotlin
❌ 나쁜 예
fun search(query: String): Call<List<Item>> {
    return retrofit.create(SearchService::class.java)
        .search("https://api.com/search?q=$query")
}

✅ 좋은 예
@GET("/search")
fun search(@Query("q") query: String): Call<List<Item>>
```

---

### RxJava vs Kotlin Flow

**언제 사용?**
| 상황 | 선택 |
|------|------|
| 기존 코드 유지보수 | RxJava |
| 새 프로젝트 | Flow |
| 다중 소스 합치기 | RxJava (merge/zip) 또는 Flow (combine) |
| 단순 비동기 처리 | Flow + suspend 함수 |

**RxJava 핵심**:
```kotlin
Observable/Flowable
├─ map, filter, flatMap
├─ subscribe { value → ... onError → ... }
└─ disposable 관리 필수

생명주기:
1. subscribe() 호출
2. onNext() 연속 호출
3. onComplete() 또는 onError()
4. dispose() 정리
```

**체크 포인트** (RxJava):
- ❌ subscribe() 후 disposable 미저장
- ❌ Activity/Fragment 컨텍스트에서 unlimited subscription
- ❌ 이전 subscription 미정리 후 새 subscribe
- ✅ CompositeDisposable로 일괄 관리
- ✅ onDestroy()에서 clear()
- ✅ backpressure 고려 (Flowable)

**코드 예**:
```kotlin
❌ 나쁜 예
override fun onCreate() {
    repository.getUsers()
        .subscribe { users → updateUI(users) }
    // disposable 없음 → 메모리 누수
}

✅ 좋은 예
private val disposable = CompositeDisposable()

override fun onCreate() {
    repository.getUsers()
        .subscribe(
            { users → updateUI(users) },
            { error → handleError(error) }
        )
        .addTo(disposable)
}

override fun onDestroy() {
    disposable.clear()
    super.onDestroy()
}
```

---

**Kotlin Flow 핵심**:
```kotlin
flow { emit(value) }
├─ cold stream (수집할 때마다 재생성)
├─ 자동 취소 (scope 종료 시)
└─ 백프레셔 자동 지원

생명주기:
1. flow { ... } 정의
2. .collect() 또는 .launchIn(scope)
3. scope 종료 시 자동 취소
```

**체크 포인트** (Flow):
- ❌ GlobalScope 사용
- ❌ suspend 함수 아닌 곳에서 호출
- ❌ collect() 후 이전 작업 미기다림
- ✅ viewModelScope, lifecycleScope 사용
- ✅ launchIn()으로 scope 명시
- ✅ collect 내에서 중단 작업 수행

**코드 예**:
```kotlin
❌ 나쁜 예
viewModel.getUsers()
    .collect { users → updateUI(users) }
// Flow 타입 누락, collect 후 계속 진행

✅ 좋은 예
viewLifecycleOwner.lifecycleScope.launch {
    viewModel.getUsers()
        .collect { users → updateUI(users) }
}
// 또는
viewModel.getUsers()
    .launchIn(viewLifecycleOwner.lifecycleScope)
```

**마이그레이션 패턴**:
```kotlin
// RxJava
Observable.just(data)
    .map { transform(it) }
    .subscribe { updateUI(it) }

// Flow 동등
flow { emit(data) }
    .map { transform(it) }
    .launchIn(scope) { updateUI(it) }  // 틀림

// Flow 올바름
flow { emit(data) }
    .map { transform(it) }
    .collect { updateUI(it) }
```

---

### Android Lifecycle

**생명주기 순서** (Activity):
```
onCreate → onStart → onResume → (사용자 상호작용) 
→ onPause → onStop → onDestroy
```

**중요 지점**:
| 메서드 | 언제 | 용도 |
|---------|------|------|
| onCreate | 1회만 | 초기화 (Intent 데이터 읽기, 뷰 생성) |
| onStart | 가시화 | 백그라운드 작업 시작 |
| onResume | 상호작용 가능 | 카메라, 위치 권한 활성화 |
| onPause | 사라짐 | 카메라, 위치 권한 정지 |
| onStop | 백그라운드 | 백그라운드 작업 중단 (but 데이터 유지) |
| onDestroy | 소멸 | 구독 정리, 리소스 해제 |

**체크 포인트**:
- ❌ onResume에서 구독, onDestroy에서 정리 (X)
- ❌ onStop에서 작업 중단 안 함 (배터리 소모)
- ❌ onCreate에서 무거운 연산 (ANR)
- ✅ 상태 저장: savedInstanceState 사용
- ✅ 리소스 정리: onPause 또는 onDestroy
- ✅ ViewModel로 생명주기 의존성 제거

**코드 예**:
```kotlin
❌ 나쁜 예
class MainActivity : AppCompatActivity() {
    override fun onResume() {
        super.onResume()
        repository.startListening()  // 정리 안 함
    }
}

✅ 좋은 예
class MainActivity : AppCompatActivity() {
    private val viewModel by viewModels<MainViewModel>()
    
    override fun onCreate() {
        super.onCreate()
        // ViewModel이 생명주기 넘는 데이터 관리
    }
    
    override fun onPause() {
        super.onPause()
        viewModel.pauseListening()
    }
}
```

---

### Room Database

**목적**: SQLite ORM

**핵심**:
```
@Entity
data class User(id: Int, name: String)

@Dao
interface UserDao {
    @Insert
    suspend fun insert(user: User)
    
    @Query("SELECT * FROM users WHERE id = :id")
    fun getUser(id: Int): Flow<User>
}

@Database
abstract class AppDb : RoomDatabase() {
    abstract fun userDao(): UserDao
}
```

**체크 포인트**:
- ❌ 마이그레이션 스킵 (fallbackToDestructiveMigration)
- ❌ UI 스레드에서 DB 쿼리
- ❌ @Query에서 복잡한 로직 (계산은 앱에서)
- ✅ suspend 함수 + Flow 사용
- ✅ 명시적 마이그레이션 (버전 관리)
- ✅ Transaction 사용 (일관성)

---

### Coroutine vs Thread

**선택 기준**:
| 상황 | 선택 |
|------|------|
| 비동기 작업 (네트워크, DB) | Coroutine |
| 블로킹 외부 라이브러리 | Dispatchers.IO |
| 메인 스레드 작업 | Dispatchers.Main |
| CPU 집약적 작업 | Dispatchers.Default |

**체크 포인트**:
- ❌ Thread 직접 생성 (Coroutine 대체 가능)
- ❌ runBlocking() 메인 스레드에서 사용
- ❌ GlobalScope.launch 사용
- ✅ viewModelScope, lifecycleScope 활용
- ✅ withContext(Dispatchers.IO)로 스레드 전환
- ✅ Job/SupervisorJob로 계층 관리

---

## 📐 Android Layout XML 최적화

### ConstraintLayout vs LinearLayout/RelativeLayout

**ConstraintLayout (권장)**:
```
장점:
- 중첩 최소화 (성능 ↑)
- 플랫한 구조 (이해하기 쉬움)
- 복잡한 레이아웃 간단 표현

단점:
- 학습곡선 높음
- 너무 단순하면 오버엔지니어링
```

**체크 포인트**:
- ❌ LinearLayout 4단계 이상 중첩
- ❌ weight 남용 (ConstraintLayout의 비율 기능 사용)
- ❌ 절대 크기 (dp 하드코딩)
- ✅ 상대적 배치 (layout_constraintTop_toBottomOf)
- ✅ dimens.xml으로 중앙화
- ✅ 최대 깊이 4단계 이내

**코드 패턴**:
```xml
❌ 깊은 중첩 (5단계)
<LinearLayout orientation="vertical">
  <LinearLayout orientation="horizontal">
    <FrameLayout>
      <NestedScrollView>
        <LinearLayout>
          <TextView/>
        </LinearLayout>
      </NestedScrollView>
    </FrameLayout>
  </LinearLayout>
</LinearLayout>

✅ ConstraintLayout (2단계)
<ConstraintLayout>
  <NestedScrollView
      app:layout_constraintTop_toTopOf="parent"/>
  <LinearLayout
      app:layout_constraintTop_toBottomOf="@id/scrollView"/>
</ConstraintLayout>
```

### Layout 성능 체크

**measure/layout 호출 최소화**:
- ❌ 레이아웃 완료 후 setLayoutParams() 반복
- ❌ View 생성 후 즉시 다시 레이아웃
- ✅ ViewStub 사용 (선택적 뷰 로드)
- ✅ include + merge로 재사용

---

## 🏗️ MVVM vs MVI 패턴 상세

### MVVM (Model-View-ViewModel)

**구조**:
```
View (Activity/Fragment)
  ↓ (관찰)
ViewModel (상태 + 로직)
  ↓ (조회)
Model (저장소, DB, API)
```

**특징**:
- 상태: 여러 개의 LiveData/StateFlow (isLoading, data, error)
- 로직: ViewModel에서 관리
- 단점: 상태 관계 불명확 (loading + error 동시?)

**체크 포인트**:
- ❌ ViewModel이 View 참조
- ❌ 상태 객체 없음 (분산된 StateFlow)
- ❌ View에서 직접 Model 접근
- ✅ ViewModel만 상태 관리
- ✅ StateFlow 사용 (관찰 가능)
- ✅ Repository 패턴으로 계층 분리

### MVI (Model-View-Intent)

**구조**:
```
View (Intent 발생)
  ↓
ViewModel (Intent 처리)
  ↓
Model (상태 계산)
  ↓
View (State 렌더링)
```

**특징**:
- 단방향 흐름: Intent → State
- 상태: 하나의 sealed class (불변)
- 로직: Intent 처리 시 새로운 State 생성

**코드 예**:
```kotlin
// Intent (사용자 액션 또는 이벤트)
sealed class HomeIntent {
    object LoadUsers : HomeIntent()
    data class SelectUser(val userId: Int) : HomeIntent()
}

// State (단일 상태 객체)
sealed class HomeState {
    object Loading : HomeState()
    data class Success(val users: List<User>, val selected: Int? = null) : HomeState()
    data class Error(val message: String) : HomeState()
}

// ViewModel (Intent → State)
class HomeViewModel : ViewModel() {
    private val _state = MutableStateFlow<HomeState>(Loading)
    val state = _state.asStateFlow()
    
    fun handleIntent(intent: HomeIntent) {
        when (intent) {
            HomeIntent.LoadUsers → loadUsers()
            is HomeIntent.SelectUser → selectUser(intent.userId)
        }
    }
    
    private fun loadUsers() {
        viewModelScope.launch {
            try {
                val users = repository.getUsers()
                _state.value = Success(users)
            } catch (e: Exception) {
                _state.value = Error(e.message ?: "Unknown error")
            }
        }
    }
    
    private fun selectUser(userId: Int) {
        val current = _state.value
        if (current is Success) {
            _state.value = current.copy(selected = userId)
        }
    }
}
```

**MVVM vs MVI 선택**:
| 기준 | MVVM | MVI |
|------|------|-----|
| 상태 복잡도 낮음 | ✅ 간단 | ⚠️ boilerplate |
| 상태 관계 복잡 | ❌ 분산 | ✅ 명확 |
| 테스트 용이 | ⚠️ 중간 | ✅ 높음 |
| 학습곡선 | ✅ 낮음 | ⚠️ 높음 |

---

## 🧩 멀티 피처 모듈화 시스템

### 권장 구조

```
app/
  ├─ build.gradle (기본 설정, 모든 모듈 의존)
  
feature/
  ├─ home/
  │  ├─ api/          (public interface)
  │  │  └─ HomeFeature.kt
  │  ├─ impl/         (구현체)
  │  │  ├─ HomeActivity.kt
  │  │  ├─ HomeViewModel.kt
  │  │  └─ build.gradle (impl만 다른 feature 의존 가능)
  │  └─ build.gradle (api만 외부 노출)
  
  ├─ user/
  │  ├─ api/
  │  └─ impl/
  
core/
  ├─ common/          (공유 인터페이스, 모델)
  ├─ network/         (Retrofit, OkHttp)
  ├─ database/        (Room)
  ├─ util/            (확장함수, 헬퍼)
  └─ build.gradle
```

### 의존성 규칙

**✅ 올바른 구조**:
```
app → feature:home:api
    → feature:user:api
    
feature:home:impl → feature:home:api
                  → core:common
                  → core:network
                  
feature:user:impl → feature:user:api
                  → core:common
                  → core:database
```

**❌ 금지 패턴**:
```
app → feature:home:impl  (구현체 직접 의존)
feature:home:impl → feature:user:impl  (feature 간 직접 통신)
core → feature:*  (역방향 의존)
```

### 모듈 간 통신

**Feature A → Feature B 통신**:
```kotlin
// feature/home/api/HomeFeature.kt
interface HomeFeature {
    fun navigateToUserDetails(userId: Int)
    fun getUserId(): Int?
}

// feature/user/impl/UserActivity.kt
class UserActivity : AppCompatActivity() {
    private val homeFeature: HomeFeature by inject()  // DI
    
    fun backToHome() {
        homeFeature.navigateToUserDetails(userId)
    }
}
```

### 리소스 네이밍

```
colors.xml
  ├─ @color/home_primary
  ├─ @color/home_secondary
  └─ @color/shared_divider

dimens.xml
  ├─ @dimen/home_item_height
  └─ @dimen/shared_spacing_default
```

---

## ⏱️ 시간복잡도 분석

### 알고리즘 선택 가이드

| 작업 | 최악 시간복잡도 | 사용처 | 주의사항 |
|------|-----------------|--------|----------|
| List.contains() | O(n) | 작은 컬렉션 | 큼 → Set 사용 |
| Set.contains() | O(1) | 조회 많음 | 메모리 ↑ |
| List.find() | O(n) | 필터 조건 | 조건 복잡 → DB 쿼리 이동 |
| Binary Search | O(log n) | 정렬된 데이터 | 정렬 비용 O(n log n) |
| Hash Map | O(1) | 빠른 조회 | 충돌 가능 |

### 루프 복잡도 체크

```kotlin
❌ O(n²) - 중첩 루프
items.forEach { outer →
    items.forEach { inner →
        if (outer.id == inner.id) process()
    }
}

❌ O(n²) - 루프 내 정렬
val results = mutableListOf<Int>()
items.forEach {
    results.add(it)
    results.sort()  // 매 반복마다 정렬
}

✅ O(n log n) - 한 번의 정렬
val sorted = items.sorted()
sorted.forEach { process(it) }

✅ O(n) - Set 조회
val itemSet = items.toSet()
check.forEach {
    if (it in itemSet) process()
}
```

### 재귀 깊이 분석

```kotlin
❌ 제한 없는 재귀
fun traverse(node: Node) {
    process(node)
    node.children.forEach { traverse(it) }  // 깊이 제한 없음
}

✅ 깊이 제한
fun traverse(node: Node, depth: Int = 0) {
    if (depth > 10) return  // 무한 재귀 방지
    process(node)
    node.children.forEach { traverse(it, depth + 1) }
}

✅ 스택 기반 (권장)
fun traverse(rootNode: Node) {
    val stack = mutableListOf(rootNode)
    while (stack.isNotEmpty()) {
        val node = stack.removeAt(stack.lastIndex)
        process(node)
        stack.addAll(node.children)
    }
}
```

---

## 💡 유지보수성 체크리스트

### 코드 품질

- [ ] 함수 길이 < 30줄?
- [ ] 함수 매개변수 < 5개?
- [ ] 순환 복잡도 < 10?
- [ ] 매직 넘버 없음?
- [ ] 명확한 변수명?
- [ ] 주석 필요한 부분만?

### 테스트 가능성

- [ ] 순수 함수 (같은 입력 → 같은 출력)?
- [ ] 외부 상태 미사용?
- [ ] Mock 가능한 의존성?
- [ ] 엣지 케이스 처리?

### 유지보수 패턴

```kotlin
❌ 유지보수 어려움
class UserManager {
    fun doSomething() {
        val user = fetchUser()  // 실제 API
        val profile = user.getProfile()  // 강결합
        
        if (user.age > 18 && user.active) {
            // 비즈니스 로직
        }
    }
}

✅ 유지보수 쉬움
class UserManager(private val userRepository: UserRepository) {
    fun isEligibleUser(userId: Int): Boolean {
        return userRepository.isAdult(userId) && 
               userRepository.isActive(userId)
    }
}

// 테스트
@Test
fun `test eligible user` {
    val repo = mockk<UserRepository>()
    every { repo.isAdult(1) } returns true
    every { repo.isActive(1) } returns true
    
    assertTrue(manager.isEligibleUser(1))
}
```

---

## 🎯 PR 리뷰 체크리스트 (라이브러리별)

### OkHttp/Retrofit 변경
- [ ] Singleton/DI로 클라이언트 재사용?
- [ ] Timeout 설정?
- [ ] Interceptor로 공통 로직 처리?
- [ ] 에러 응답 처리 (@Query, @Body 올바름)?

### RxJava 코드
- [ ] CompositeDisposable 사용?
- [ ] onDestroy()에서 정리?
- [ ] 스레드 지정 (.subscribeOn, .observeOn)?
- [ ] 에러 처리 (onError)?

### Flow/Coroutine 코드
- [ ] viewModelScope 또는 lifecycleScope?
- [ ] suspend 함수 사용?
- [ ] collect 또는 launchIn?
- [ ] 예외 처리 (try-catch 또는 catch{})?

### Lifecycle 관련
- [ ] 라이프사이클 메서드 순서 올바름?
- [ ] 리소스 정리 (onPause/onDestroy)?
- [ ] ViewModel 사용?
- [ ] savedInstanceState 사용?

### Layout XML 검토
- [ ] 뷰 계층 깊이 ≤ 4단계?
- [ ] 불필요한 ViewGroup 제거?
- [ ] colors.xml, dimens.xml 활용?
- [ ] merge 태그 사용 (include)?
- [ ] ConstraintLayout 권장 구조?

### MVVM/MVI 패턴
- [ ] ViewModel이 View 참조 안 함?
- [ ] 상태 관리 명확 (단일 객체 또는 분산)?
- [ ] MVVM: 여러 LiveData/StateFlow 관계 명확?
- [ ] MVI: Intent → State 단방향 흐름?
- [ ] 패턴 일관성 (MVVM 파일에 MVI 스타일 코드 혼용 X)?

### 함수/로직 가독성
- [ ] 함수 길이 < 30줄?
- [ ] 함수 매개변수 < 5개?
- [ ] 함수 책임 단일 (SRP)?
- [ ] 변수명 명확 (약자 최소)?
- [ ] 복잡한 로직 주석 있음?

### 모듈화 (Multi-Feature)
- [ ] 모듈 구조 (app → feature:api → core)?
- [ ] 의존성 방향 올바름 (역방향 금지)?
- [ ] feature:api 와 feature:impl 분리?
- [ ] feature 간 공유 인터페이스 (core:common)?
- [ ] 리소스 네이밍 (feature_* 접두사)?

### 시간복잡도 & 성능
- [ ] 중첩 루프 O(n²) 이상?
- [ ] while/do-while 대체 가능?
- [ ] 재귀 깊이 제한?
- [ ] 불필요한 정렬/연산?
- [ ] List 대신 Set/Map 활용?

### 유지보수성
- [ ] 테스트 가능한 구조?
- [ ] 순수 함수 활용?
- [ ] 강결합 제거 (DI 사용)?
- [ ] 매직 넘버 상수화?
- [ ] 명확한 에러 메시지?

---

## 💡 맥락 파악 가이드

리뷰 시 반드시 확인하세요:

1. **호출 흐름**: "이 함수를 누가 언제 부르나?"
   ```
   예: Activity.onCreate() 
       → ViewModel.load()
       → Repository.fetchUsers()
       → OkHttp 요청
   ```

2. **생명주기**: "이 코드가 실행되는 시점은?"
   ```
   예: Fragment.onViewCreated()에서 Flow.collect()
       → Fragment 파괴 시 자동 취소됨 (좋음)
   ```

3. **메모리**: "리소스가 정리되나?"
   ```
   예: EventListener 등록 → onDestroy()에서 제거?
   ```

4. **병렬성**: "동시 실행 문제는?"
   ```
   예: 같은 변수를 여러 코루틴이 수정?
   ```

5. **라이브러리 능력**: "라이브러리 기능을 다 쓰나?"
   ```
   예: Retrofit @Query 대신 수동 URL 조립?
   ```
