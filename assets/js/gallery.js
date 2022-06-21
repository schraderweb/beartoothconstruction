const { createApp } = Vue;

createApp({
  data() {
    return {
      collections: null,
      isTrue: false,
      setUrl: null,
    };
  },
  async mounted() {
    await axios
      .get(
        "https://whispering-atoll-99593.herokuapp.com/api/posts?populate=images"
      )
      .then((res) => {
        const { data } = res.data;
        this.collections = data;
      });
  },
  methods: {
    getUrl(url) {
      this.setUrl = url;
      this.isTrue = true;
    },
    closeMe() {
      this.isTrue = false;
    },
  },
}).mount("#app");
